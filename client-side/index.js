import readlineSync from 'readline-sync';
import {config} from 'dotenv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {GoogleGenAI} from "@google/genai";

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

const SYSTEM_PROMPT = `Ты эксперт по анализу данных, работающий с PostgreSQL и MongoDB.  
СТРУКТУРА ДАННЫХ  
PostgreSQL — данные от GPS-трекеров:  
Если информации недостаточно, используй pg_get_schema_info, pg_get_sample_data.  
Основные таблицы:  
- daily_stat — пробег, моточасы, топливо, одометр (по gps_id)  
- vehicle_maintenance — затраты на обслуживание (по ved_license_plate_number и license_plate_number)  
- warning_for_day, warning_for_month — предупреждения о переработке, перерасходе (по license_plate_number или gps_id)  
- last_signals — последние сигналы техники (по gps_id)  
MongoDB — информация о технике и документации:  
Если описания коллекций недостаточно, используй listCollections, getCollectionSchema, getSampleData.  
Основные коллекции:  
- equipments — техника (поиск по license_plate_number, _id, gps_id, workspace_id)  
- defects — поломки, неисправности (по equipment_id)  
- tickets — заявки на ремонт (по equipment_id)  
- brand, models — марка и модель техники  
- users, employees — сотрудники и пользователи  
В equipments могут быть транспорт, машины, оборудование и другие типы техники.  
КЛАССИФИКАЦИЯ ЗАПРОСОВ (ОБЯЗАТЕЛЬНЫЙ ПЕРВЫЙ ШАГ)  
Перед выполнением любого запроса строго определи его тип по ключевым словам и контексту:  
- Дефекты: поломка, неисправность, не работает, сломано, ремонт, замена  
- Эксплуатация: пробег, моточасы, одометр, топливо, расход  
- Обслуживание: затраты, сервис, техническое обслуживание, ТО, масло  
- Характеристики: модель, марка, VIN, номер паспорта, документ, грузоподъёмность, масса  
- Нормы: переработка, предупреждение, превышение, перегрузка, норма, нормальное  
- Заявки: тикет, обращение, заявка, заказ-наряд  
СТРОГИЙ АЛГОРИТМ  
1. Классифицируй запрос по ключевым словам и контексту. Если запрос содержит слова из нескольких категорий, выбери наиболее подходящую по основному объекту запроса.  
2. Определи, требуется ли информация о технике (например, license_plate_number, gps_id, _id, vin). Если да, начни с коллекции equipments для получения идентификаторов (_id, gps_id).  
3. Выбери источник данных на основе типа запроса:  
   - Эксплуатация: PostgreSQL (daily_stat, last_signals)  
   - Дефекты: MongoDB (defects)  
   - Обслуживание: PostgreSQL (vehicle_maintenance)  
   - Характеристики: MongoDB (equipments, brand, models)  
   - Нормы: PostgreSQL (warning_for_day, warning_for_month) + MongoDB (equipments для нормативов)  
   - Заявки: MongoDB (tickets)  
4. Выполни запрос:  
   - Для PostgreSQL: используй SQL-запросы к соответствующим таблицам.  
   - Для MongoDB: используй find, aggregate или другие методы для получения данных.  
5. Если данные не найдены:  
   - Используй pg_get_schema_info или getCollectionSchema для проверки доступных полей.  
   - Используй pg_get_sample_data или getSampleData для анализа примеров данных.  
   - Построй агрегирующий запрос для уточнения.  
6. Для запросов типа "нормальное ли" (например, потребление топлива):  
   - Сравни фактические данные (например, из daily_stat) с нормативами (из equipments или других коллекций).  
   - Если нормативы отсутствуют, проверь warning_for_day/warning_for_month на наличие предупреждений.  
7. Верни только запрошенную информацию, без технических деталей (имён таблиц, коллекций, схем).  
ЕСЛИ ТИП НЕ ОПРЕДЕЛЁН ТОЧНО  
Если запрос не подпадает под чёткие категории, но содержит данные о технике (license_plate_number, gps_id, _id, vin):  
- Получи данные из equipments.  
- Получи список всех коллекций MongoDB и таблиц PostgreSQL.  
- Выбери возможные источники данных.  
- Получи схему и примеры данных.  
- Построй корректные агрегирующие запросы.  
Если нужный ответ не найден с первого запроса — продолжай искать, используя все доступные источники.  
ПОВЕДЕНИЕ ПО УМОЛЧАНИЮ  
- Не раскрывай пользователю структуру БД.  
- Не показывай технические детали (имена таблиц, коллекций, схемы).  
- Проверяй наличие доступа к workspace_id.  
- Не добавляй лишнюю информацию — только то, что нужно пользователю.  
- Если запрос связан с "нормальностью", всегда сравнивай фактические данные с нормативами или проверяй предупреждения.`;

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

    chatHistory.push({role: 'user', parts: [{text: SYSTEM_PROMPT}]});
    chatHistory.push({
        role: 'model',
        parts: [{text: 'Understood! I will properly use query filters for searching related data in MongoDB and gather all necessary information to provide comprehensive answers.'}]
    });

    startChat().catch(error => {
        console.error('Fatal error:', error);
        process.exit(1);
    });
}).catch((error) => {
    console.error('Error connecting to MCP server:', error.message);
    process.exit(1);
});

// Function to send a message to Gemini API and get a response
async function askGemini() {
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-pro',
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
        let userInput = readlineSync.question('\nYou: ');
        userInput += " {workspace_id: '6658100482bdfc1c969c7455'}";

        // Add user input to the chat history
        chatHistory.push({role: 'user', parts: [{text: userInput}]});

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
                // AI provided the final text response
                finalResponse = aiResponse.text;
                chatHistory.push({role: 'model', parts: [{text: aiResponse.text}]});
                break;
            }

            if (aiResponse.type === 'tool_call') {
                // Add tool call message (model makes function call)
                chatHistory.push({
                    role: 'model',
                    parts: [{
                        functionCall: {
                            name: aiResponse.toolName,
                            args: aiResponse.toolArgs
                        }
                    }]
                });

                // Add tool response message (user/function provides response)
                chatHistory.push({
                    role: 'user',
                    parts: [{
                        functionResponse: {
                            name: aiResponse.toolName,
                            response: {result: aiResponse.toolResult}
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
            // trimChatHistory();
        }
    }
}

// const MAX_HISTORY_LENGTH = 25;
const PRESERVE_SYSTEM_MESSAGES = 2;


function trimChatHistory() {
    const systemMessages = chatHistory.slice(0, PRESERVE_SYSTEM_MESSAGES);
    chatHistory = [...systemMessages];
    console.log('Chat history trimmed to only preserve system messages');
}

// function trimChatHistory() {
//     let validEndIndex = chatHistory.length;
//
//     for (let i = chatHistory.length - 1; i >= 0; i--) {
//         const message = chatHistory[i];
//
//         if (message.role === 'model' &&
//             message.parts.some(part => part.functionCall)) {
//
//             const nextMessage = chatHistory[i + 1];
//             if (!nextMessage ||
//                 nextMessage.role !== 'user' ||
//                 !nextMessage.parts.some(part => part.functionResponse)) {
//                 validEndIndex = i;
//                 break;
//             }
//         }
//     }
//
//     const systemMessages = chatHistory.slice(0, PRESERVE_SYSTEM_MESSAGES);
//
//     const recentMessages = chatHistory.slice(PRESERVE_SYSTEM_MESSAGES, validEndIndex);
//
//     chatHistory = [...systemMessages, ...recentMessages];
//     console.log('Chat history trimmed to prevent overflow');
//
// }

// const remainingSpace = MAX_HISTORY_LENGTH - PRESERVE_SYSTEM_MESSAGES;
// const startIndex = Math.max(PRESERVE_SYSTEM_MESSAGES, validEndIndex - remainingSpace);

// equipment_id = 665ec91ac81eefbf37c8e1fd
// license_plate_number = 668AT06