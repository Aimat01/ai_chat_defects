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

// СИСТЕМНЫЙ ПРОМПТ для лучшего понимания MongoDB запросов
const SYSTEM_PROMPT = `You are a MongoDB database assistant. Follow these rules:

1. ALWAYS use query filters when counting or finding specific related data
2. When user asks "how many X have Y", use countDocuments with proper query filter
3. Common field relationships:
   - defects.equipment_id → equipments._id
   - equipments.brand_id → brands._id  
   - equipments.workspace_id → workspaces._id

4. Examples of correct queries:
   - "how many defects have equipment X" → countDocuments('defects', {'equipment_id': 'X'})
   - "find equipment with brand Y" → findDocuments('equipments', {'brand_id': 'Y'})

5. If you're unsure about field names, use getCollectionSchema first
6. Use findDocuments when user wants to see data, countDocuments when they want counts
7. Always include appropriate query filters - never use empty {} query for relationship questions`;

const mcpClient = new Client({
    name: 'mongodb-gemini-chatbot',
    version: "1.0.0",
});

// Try to connect to MCP server with better error handling
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
    
    // Добавляем системный промпт в начало истории
    chatHistory.push({ role: 'user', parts: [{ text: SYSTEM_PROMPT }] });
    chatHistory.push({ role: 'model', parts: [{ text: 'Understood! I will properly use query filters for searching related data in MongoDB.' }] });
    
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
        contents:chatHistory,
        config:{
            tools: [
                {
                    functionDeclarations: tools,
                }
            ]
        }
    });
    const functionCall = response.candidates[0].content.parts[0].functionCall;

    if (functionCall) {
        console.log('🔧 Tool used:', functionCall.name);
        console.log('📝 Parameters:', JSON.stringify(functionCall.args, null, 2));
        
        const toolResponse = await mcpClient.callTool(
           {
                name: functionCall.name,
                arguments: functionCall.args
           }
        );

        // Исправленная логика обработки ответа
        if (toolResponse.content && toolResponse.content.length > 0) {
            // Берем первый content item, который содержит полный результат
            return toolResponse.content[0].text;
        }

        return "No content received from tool";
    }

    return response.candidates[0].content.parts[0].text;
  } catch (error) {
    console.error('Error communicating with Gemini API:', error);
    return 'Sorry, I encountered an error while processing your request.';
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
    
    // Get AI response
    const aiResponse = await askGemini();

    // Add AI response to chat history
    chatHistory.push({ role: 'model', parts: [{ text: aiResponse }] });
    
    // Display AI response
    console.log('\nAI:', aiResponse);
  }
}