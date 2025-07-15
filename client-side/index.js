import readlineSync from 'readline-sync';
import { config } from 'dotenv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { GoogleGenAI } from "@google/genai";

// Load environment variables
config();

// Initialize the Google Generative AI with your API key
const apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
  console.error('Error: Gemini API key not found. Please add it to your .env file.');
  process.exit(1);
}

const ai = new GoogleGenAI({apiKey});

let tools = [];
let chatHistory = [];

const SYSTEM_PROMPT = `You are a database assistant that works with both MongoDB and PostgreSQL. Follow these rules:

1. **Database Selection Logic:**
   - Use **PostgreSQL ONLY** when working with these specific tables: daily_stat, last_signals, norms_for_month, norms_for_day, vehicle_maintenance, warning_for_day, warning_for_month
   - Use **MongoDB** for all other data (equipments, defects, brands, etc.)
   - **NEVER** look at PostgreSQL tables other than the 7 specified above
   - **IGNORE** any MongoDB collections that have similar names to the PostgreSQL tables above - they are outdated

2. ALWAYS use query filters when counting or finding specific related data.
3. When user asks "how many X have Y", use appropriate count functions with proper query filters
4. Before making assumptions about table/collection relationships, ALWAYS:
   - Use listCollections (for MongoDB) or pg_get_schema_info (for specific PostgreSQL tables only)
   - Use getCollectionSchema (MongoDB) or pg_get_schema_info (PostgreSQL) to understand structures
   - Look for fields ending with '_id' or 'Id' that might be references

5. Examples of correct queries:
   **MongoDB (for equipments, defects, brands, etc.):**
   - "how many defects have equipment X" → countDocuments('defects', {'equipment_id': 'X'})
   - "find equipment with brand Y" → findDocuments('equipments', {'brand_id': 'Y'})

   **PostgreSQL (ONLY for the 7 specific tables):**
   - "daily statistics for equipment X" → pg_execute_query('SELECT * FROM daily_stat WHERE equipment_id = $1', ['X'])
   - "vehicle maintenance records" → pg_execute_query('SELECT * FROM vehicle_maintenance WHERE ...')

6. If you're unsure about collection names or field names in MongoDB, use getCollectionSchema first
7. For PostgreSQL, only query the 7 specified tables: daily_stat, last_signals, norms_for_month, norms_for_day, vehicle_maintenance, warning_for_day, warning_for_month
8. Use findDocuments/pg_execute_query(SELECT) when user wants to see data, countDocuments/pg_execute_query(COUNT) when they want counts
9. Always include appropriate query filters - never use empty {} query or WHERE 1=1 for relationship questions
10. User can ask about different statistics or efficiency about equipments, defects, brands, etc.
    You have to decide by yourself how you will calculate efficiency using both databases as needed

11. When analyzing data, you should:
    - First determine which database contains the needed data
    - Get the collection/table schema to understand the structure
    - Use appropriate queries to gather the data from both databases if needed
    - Analyze and aggregate the results
    - Provide a comprehensive answer based on your analysis

12. IMPORTANT: 
    - Never assume collection/table names or relationships exist without checking first
    - For PostgreSQL: ONLY work with the 7 specified tables
    - For MongoDB: Use for all other business data
    - Ignore outdated MongoDB collections that match PostgreSQL table names

13. When you have gathered all necessary data and can provide a complete answer, simply provide your final response without calling any more tools.
14. If collection/table do not contain any id (equipment_id) you can use data like license_plate_number and also on for linking between collections/tables`;
const mcpClient = new Client({
    name: 'mongodb-gemini-chatbot',
    version: "1.0.0",
});

// Try to connect to the MCP server with better error handling
mcpClient.connect(new SSEClientTransport(new URL("http://localhost:3001/sse"))).then(async () => {
    console.log('Connected to MCP server');
    // Transform tools to match Gemini's expected format
    const toolsList = await mcpClient.listTools();
    tools = toolsList.tools.map(tool => {
        // Create a clean version of properties without additionalProperties and default
        const cleanProperties = {};
        
        for (const [key, value] of Object.entries(tool.inputSchema.properties || {})) {
            cleanProperties[key] = {
                description: value.description || '',
                type: value.type || 'string'
            };
            
            // Handle nested properties
            if (value.properties) {
                const nestedProperties = {};
                for (const [nestedKey, nestedValue] of Object.entries(value.properties)) {
                    nestedProperties[nestedKey] = {
                        description: nestedValue.description || '',
                        type: nestedValue.type || 'string'
                    };
                }
                cleanProperties[key].properties = nestedProperties;
            }
            
            // Handle items for arrays
            if (value.items) {
                cleanProperties[key].items = {
                    type: value.items.type || 'string'
                };
            }
        }
        
        return {
            name: tool.name,
            description: tool.description,
            parameters: {
                type: tool.inputSchema.type,
                properties: cleanProperties,
                required: tool.inputSchema.required || []
            }
        };
    });
    
    console.log('Available tools:', 
        tools.map(tool => tool.name).join(', ')
    );
    
    chatHistory.push({ role: 'user', parts: [{ text: SYSTEM_PROMPT }] });
    chatHistory.push({ role: 'model', parts: [{ text: 'Understood! I will properly use query filters for searching related data in MongoDB and gather all necessary information to provide comprehensive answers.' }] });
    
    startChat().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}).catch((error) => {
    console.error('Error connecting to MCP server:', error.message);
    process.exit(1);
});

// Function to send message to Gemini API and get response
async function askGemini() {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: chatHistory,
            config: {
                tools: [
                    {
                        functionDeclarations: tools,
                    }
                ]
            }
        });
        const content = response.candidates[0].content;
        const parts = content.parts;

        // Check if there's a function call
        const functionCallPart = parts.find(part => part.functionCall);
        
        if (functionCallPart) {
            const functionCall = functionCallPart.functionCall;
            console.log('🔧 Tool used:', functionCall.name);
            console.log('📝 Parameters:', JSON.stringify(functionCall.args, null, 2));

            const toolResponse = await mcpClient.callTool({
                name: functionCall.name,
                arguments: functionCall.args
            });

            let toolResult = "No content received from tool";
            if (toolResponse.content && toolResponse.content.length > 0) {
                toolResult = toolResponse.content[0].text;
            }

            return {
                type: 'tool_call',
                toolName: functionCall.name,
                toolArgs: functionCall.args,
                toolResult: toolResult
            };
        }

        // If no function call, return text response
        const textPart = parts.find(part => part.text);
        if (textPart) {
            return {
                type: 'text',
                text: textPart.text
            };
        }

        return {
            type: 'text',
            text: 'No response received from AI'
        };
    } catch (error) {
        console.error('Error communicating with Gemini API:', error);
        return {
            type: 'error',
            text: 'Sorry, I encountered an error while processing your request.'
        };
    }
}

// Main chat loop
async function startChat() {
    console.log('\n===================================');
    console.log('🤖 Terminal Chatbot with Gemini AI');
    console.log('===================================');
    console.log('Type "exit" or "quit" to end the conversation.\n');

    while (true) {
        const userInput = readlineSync.question('\nYou: ');

        // Add user input to chat history
        chatHistory.push({ role: 'user', parts: [{ text: userInput }] });

        // Check if user wants to exit
        if (['exit', 'quit'].includes(userInput.toLowerCase())) {
            console.log('\nGoodbye! 👋');
            break;
        }

        console.log('\nAI is thinking...');

        // Iterative tool calling pipeline
        let finalResponse = '';
        let iterationCount = 0;
        const maxIterations = 15;

        while (iterationCount < maxIterations) {
            iterationCount++;
            
            const aiResponse = await askGemini();
            
            if (aiResponse.type === 'error') {
                finalResponse = aiResponse.text;
                break;
            }
            
            if (aiResponse.type === 'text') {
                // AI provided final text response
                finalResponse = aiResponse.text;
                chatHistory.push({ role: 'model', parts: [{ text: aiResponse.text }] });
                break;
            }
            
            if (aiResponse.type === 'tool_call') {
                // Add tool call and result to chat history
                chatHistory.push({
                    role: 'model',
                    parts: [{ 
                        functionCall: { 
                            name: aiResponse.toolName, 
                            args: aiResponse.toolArgs 
                        } 
                    }]
                });
                
                chatHistory.push({
                    role: 'function',
                    parts: [{ 
                        functionResponse: { 
                            name: aiResponse.toolName, 
                            response: { result: aiResponse.toolResult } 
                        } 
                    }]
                });
                
                // Continue the loop to get the next response
                continue;
            }
        }

        if (iterationCount >= maxIterations) {
            finalResponse = "I've reached the maximum number of tool calls. Let me provide you with what I've found so far.";
        }

        if (finalResponse) {
            console.log('\nAI:', finalResponse);
        }
    }
}