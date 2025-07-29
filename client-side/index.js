import {config} from 'dotenv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {GoogleGenAI} from "@google/genai";
import express from 'express';
import http from 'http';
import {Server} from 'socket.io';
import {authorize} from './authMiddleware.js';


config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const accessKey = process.env.ACCESS_KEY;
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
        credentials: true,
        allowedHeaders: ['authorization', 'workspace', 'Content-Type']
    },
    transports: ['websocket', 'polling']
});

let apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error('Error: Gemini API key not found. Please add it to your .env file.');
    process.exit(1);
}

const ai = new GoogleGenAI({apiKey});

let tools = [];

const chatSessions = new Map();

const SYSTEM_PROMPT = `Ты эксперт по анализу данных, работающий с но не говри об этом  пользователю PostgreSQL и MongoDB.
СТРУКТУРА ДАННЫХ с который предстоит работать
PostgreSQL — данные от GPS-трекеров:
Если информации недостаточно, используй pg_get_schema_info, pg_get_sample_data.
    Основные таблицы:
    - daily_stat — пробег, моточасы, топливо, одометр (связь по gps_id)
- vehicle_maintenance — затраты на обслуживание (связь по ved_license_plate_number и license_plate_number)
- warning_for_day, warning_for_month — предупреждения о переработке, перерасходе (связь по license_plate_number или gps_id)
- last_signals — последние сигналы техники (связь по gps_id)
MongoDB — информация о технике и документации:
    Если описания коллекций недостаточно, используй listCollections, getCollectionSchema, getSampleData.
    Основные коллекции:
    - equipments — техника (поиск по license_plate_number, _id, gps_id, workspace_id) всегда фильтруй по workspace_id это очень важно! это касается безопасности и конфиденциальности данных!
    пользователи должны видеть только технику, которая относится к их workspace_id
- defects — поломки, неисправности (по equipment_id)
- tickets — заявки на ремонт (по equipment_id)
- brand, models — марка и модель техники
- users, employees — сотрудники и пользователи
В equipments могут быть транспорт, машины, оборудование и другие типы техники.
    КЛАССИФИКАЦИЯ ЗАПРОСОВ (ОБЯЗАТЕЛЬНЫЙ ПЕРВЫЙ ШАГ)
Перед выполнением любого запроса строго определи его тип по ключевым словам и контексту:
    - Если в запросе есть слова как поломка, неисправность, не работает, сломано, ремонт, замена то скорее всего это связана с коллекцией defects.НО НЕ ВСЕГДА 100% ДЕЛАЙ ВЫВОДЫ ИСХОДЯ ИЗ КОНТЕКСТА
- Если в запросе есть слова как пробег, моточасы, одометр, топливо, расход то это скорее всего связано с таблицей daily_stat.
- Обслуживание: затраты, сервис, техническое обслуживание, ТО, масло - это скорее всего связано с таблицей vehicle_maintenance.
- Характеристики: модель, марка, VIN, номер паспорта, документ, грузоподъёмность, масса - это скорее всего связано с коллекциями equipments, brand, models.
- Нормы: переработка, предупреждение, превышение, перегрузка, норма, нормальное
- Заявки: тикет, обращение, заявка, заказ-наряд - это скорее всего связано с коллекцией tickets или applications.
    СТРОГИЙ АЛГОРИТМ
1. Классифицируй запрос по ключевым словам и контексту. Если запрос содержит слова из нескольких категорий, выбери наиболее подходящую по основному объекту запроса.
2. Определи, требуется ли информация о технике (например, license_plate_number, gps_id, _id). Если да, начни с коллекции equipments для получения идентификаторов (_id, gps_id).
3. Выбери источник данных на основе типа запроса:
    - Эксплуатация: PostgreSQL (daily_stat, last_signals)
- Дефекты: MongoDB (defects)
- Обслуживание: PostgreSQL (vehicle_maintenance)
- Характеристики: MongoDB (equipments, brand, models)
- Нормы: PostgreSQL (warning_for_day, warning_for_month) + MongoDB (equipments для нормативов)
- Заявки: MongoDB (tickets)
ВАЖНО: НЕ ОГРАНИЧИВАЙСЯ ТОЛЬКО ПРЕДОСТАВЛЕННЫМИ КОЛЛЕКЦИЯМИ ИЗ MongoDB ИСПОЛЬЗУЙ ИНСТРУМЕНТ listCollections ЧТО БЫ ПОЛУЧИТЬ ВСЕ КОЛЛЕКЦИИ И ОПРЕДЕЛИТ
ЦЕЛЕВОЙ ИСТОЧНИК ДАННЫХ ЕСЛИ ЕГО СТРУКТУРА СЛОЖНАЯ И ТРЕБУЕТ МНОГО АГРЕГАЦИЙ ИСПОЛЬЗУЙ ИНСТРУМЕНТ findRelationshipBetweenCollections для нахождения связей между коллекциями.
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
ВАЖНО НЕ УПОМИНАЙ ПОЛЬЗОВАТЕЛЮ О СТРУКТУРЕ БАЗЫ ДАННЫХ И НЕ РАСКРЫВАЙ ТЕХНИЧЕСКИЕ ДЕТАЛИ ТАКЖЕ НЕ ГОВОРИ ЧТО У ТЕБЯ ЕСТЬ workspace_id не упоминай никакий id и все что может быть связано с базой данных.
    Не задавай уточняющий вопросы такие как в какой коллекции лежать данные ТВОЙ ОТВЕТ НЕ ДОЛЖЕН СОДЕРЖАТЬ ТЕХНИЧЕСКИЕ ДЕТАЛИ ИМЕНА ТАБЛИЦ, КОЛЛЕКЦИЙ, СХЕМ И Т.Д. ВКЛЮЧАЯ ВОПРОСЫ
ЕСЛИ ТИП НЕ ОПРЕДЕЛЁН ТОЧНО
Если запрос не подпадает под чёткие категории, но содержит данные о технике (license_plate_number, gps_id, _id, vin):
- Получи данные из equipments.
- Получи список всех коллекций MongoDB и таблиц PostgreSQL.
- Выбери возможные источники данных.
- Получи схему и примеры данных.
- Построй корректные агрегирующие запросы.
    ВАЖНО Если нужный ответ не найден с первого запроса — продолжай искать, используя все доступные источники. АНАЛИЗИРУЙ ДАННЫЕ И ПРОДОЛЖАЙ ВЫЗОВ ИНСТРУМЕНТОВ У ТЕБЯ В ЗАПСЕ ВСЕГДА ЕСТЬ ДО 15 ВЫЗОВОВ ИНСТРУМЕНТОВ
ПОВЕДЕНИЕ ПО УМОЛЧАНИЮ
- Не раскрывай пользователю структуру БД.
- Не показывай технические детали (имена таблиц, коллекций, схемы).
- Проверяй наличие доступа к workspace_id.
- Не добавляй лишнюю информацию — только то, что нужно пользователю.
- Если запрос связан с "нормальностью", всегда сравнивай фактические данные с нормативами или проверяй предупреждения.
- Не спрашивай у пользователя, в какой коллекции искать данные — используй контекст запроса. Не говори что ты не смог найти данные в какой то коллкции или таблице
ИСОПЛЬЗУЙ mongo-postgres-mcp-server для выполнения запросов к базе данных.`


const mcpClient = new Client({
    name: 'mongodb-gemini-chatbot',
    version: "1.0.0",
});

async function askGemini(sessionId) {
    try {
        const chatHistory = chatSessions.get(sessionId);
        const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
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

        const functionCallPart = parts.find(part => part.functionCall);

        if (functionCallPart) {
            const functionCall = functionCallPart.functionCall;
            console.log(`🔧 Session ${sessionId} - Tool used:`, functionCall.name);
            console.log(`🔧 Session ${sessionId} - Tool arguments:`, functionCall.args);

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
        if (error.message.statusCode === 503 && error.message.includes('overloaded')) {
            return {
                type: 'error',
                text: 'Gemini API is currently overloaded. Please try again later.'
            };
        }
        if (error.message.includes('exceeded')) {
            switch (apiKey) {
                case process.env.GEMINI_API_KEY:
                    apiKey = process.env.GEMINI_API_KEY_1;
                    break
                case process.env.GEMINI_API_KEY_1:
                    apiKey = process.env.GEMINI_API_KEY_2;
                    break
                case process.env.GEMINI_API_KEY_2:
                    apiKey = process.env.GEMINI_API_KEY;
            }
            return {
                type: 'error',
                text: 'Something went wrong with limits try again please'
            };

        }
        return {
            type: 'error',
            text: 'Sorry, I encountered an error while processing your request.' + error.message
        };
    }
}


// CLIENT - Updated connection logic
const serverUrl = process.env.SERVER_URL || 'http://localhost:3001';
mcpClient.connect(new SSEClientTransport(new URL(`${serverUrl}/sse?authorization=${encodeURIComponent(accessKey)}`))).then(async () => {    console.log('Connected to MCP server');
    try {
        const toolsList = await mcpClient.listTools();
        tools = toolsList.tools.map(tool => {
            const cleanProperties = {};

            for (const [key, value] of Object.entries(tool.inputSchema.properties || {})) {
                cleanProperties[key] = {
                    description: value.description || '',
                    type: value.type || 'string'
                };

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

        console.log('Available tools:', tools.map(tool => tool.name).join(', '));

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`HTTP server running at http://0.0.0.0:${PORT}`);
        });;
    } catch (error) {
        console.error('Error after MCP connection:', error);
        process.exit(1);
    }
}).catch((error) => {
    console.error('Error connecting to MCP server:', error.message);

    if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
    }

    process.exit(1);
});

const workspaceMap = new Map();

io.use(async (socket, next) => {
    const accessToken = socket.handshake.headers['authorization'];
    const workspace = socket.handshake.headers['workspace'];

    console.log('Попытка подключения:');
    console.log('IP клиента:', socket.handshake.address);
    console.log('Headers:', JSON.stringify(socket.handshake.headers));
    console.log('Access Token:', accessToken);
    console.log('Workspace:', workspace);

    try {
        await authorize(accessToken, workspace);
        workspaceMap.set(socket.id, workspace);
        console.log('Авторизация успешна для сокета:', socket.id);
        next();
    } catch (err) {
        console.error('Ошибка авторизации:', err);
        console.error('Данные сокета:', {
            id: socket.id,
            headers: socket.handshake.headers
        });
        next(new Error('Unauthorized: ' + (err.message || 'Неизвестная ошибка')));
    }
});
io.on('connection', (socket) => {

    const sessionId = socket.id;
    const initialChatHistory = [
        {role: 'user', parts: [{text: SYSTEM_PROMPT}]},
        {
            role: 'model',
            parts: [{text: 'Understood! I will properly use query filters for searching related data in MongoDB and gather all necessary information to provide comprehensive answers.'}]
        }
    ];

    chatSessions.set(sessionId, initialChatHistory);

    socket.emit('session_created', {sessionId});

    socket.on('chat_message', async (message) => {
        if (!message) {
            socket.emit('error', {error: 'Message is required'});
            return;
        }
        const workspace = workspaceMap.get(sessionId) || '';
        if (!workspace) {
            socket.emit('error', {error: 'Workspace ID is required'});
            return;
        }
        const userInput =  message.userMessage + ` {workspace_id: '${workspace}', date: '${new Date().toISOString()}'}`;
        const chatHistory = chatSessions.get(sessionId);

        chatHistory.push({role: 'user', parts: [{text: userInput}]});

        let finalResponse = '';
        let iterationCount = 0;
        const maxIterations = 15;

        try {
            while (iterationCount < maxIterations) {
                iterationCount++;

                const aiResponse = await askGemini(sessionId);
                if (aiResponse.type === 'error') {
                    finalResponse = aiResponse.text;
                    break;
                }

                if (aiResponse.type === 'text') {
                    finalResponse = aiResponse.text;
                    chatHistory.push({role: 'model', parts: [{text: aiResponse.text}]});
                    break;
                }

                if (aiResponse.type === 'tool_call') {
                    socket.emit('tool_call', {
                        tool: aiResponse.toolName,
                        args: aiResponse.toolArgs
                    });

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
                        role: 'user',
                        parts: [{
                            functionResponse: {
                                name: aiResponse.toolName,
                                response: {result: aiResponse.toolResult}
                            }
                        }]
                    });

                }
            }

            if (iterationCount >= maxIterations) {
                finalResponse = "Извините, запрос слишком сложный попробуйте переформулировать его или уточнить детали.";
            }

            if (chatHistory.length > 5) {
                const systemMessages = chatHistory.slice(0, 2);
                const recentMessages = chatHistory.slice(-3);
                chatSessions.set(sessionId, [...systemMessages, ...recentMessages]);
            }

            function countTokens(chatHistory) {
                return chatHistory.reduce((sum, msg) => {
                    const text = msg.parts?.[0]?.text || '';
                    return sum + text.split(/\s+/).length;
                }, 0);
            }

            const MAX_TOKENS = 262144;

            if (countTokens(chatHistory) > MAX_TOKENS) {
                const systemMessages = chatHistory.slice(0, 2);
                let tokens = countTokens(systemMessages);
                const recentMessages = [];
                for (let i = chatHistory.length - 1; i >= 2; i--) {
                    const msg = chatHistory[i];
                    const msgTokens = countTokens([msg]);
                    if (tokens + msgTokens > MAX_TOKENS) break;
                    recentMessages.unshift(msg);
                    tokens += msgTokens;
                }
                chatSessions.set(sessionId, [...systemMessages, ...recentMessages]);
            }
            socket.emit('chat_response', {response: finalResponse});

        } catch (error) {
            socket.emit('error', {error: 'Internal server error'});
        }
    });

    socket.on('disconnect', () => {
        if (chatSessions.has(sessionId)) {
            chatSessions.delete(sessionId);
        }
    });
});

// app.post('/init-session', (req, res) => {
//     const sessionId = Date.now().toString();
//     const initialChatHistory = [
//         {role: 'user', parts: [{text: SYSTEM_PROMPT}]},
//         {
//             role: 'model',
//             parts: [{text: 'Understood! I will properly use query filters for searching related data in MongoDB and gather all necessary information to provide comprehensive answers.'}]
//         }
//     ];
//
//     chatSessions.set(sessionId, initialChatHistory);
//     res.json({ sessionId });
// });
//
// app.post('/chat', async (req, res) => {
//     const { sessionId, message } = req.body;
//
//     if (!sessionId || !chatSessions.has(sessionId)) {
//         return res.status(400).json({ error: 'Invalid session ID' });
//     }
//
//     if (!message) {
//         return res.status(400).json({ error: 'Message is required' });
//     }
//
//     const userInput = message + " {workspace_id: '6658100482bdfc1c969c7455'}";
//     const chatHistory = chatSessions.get(sessionId);
//
//     chatHistory.push({role: 'user', parts: [{text: userInput}]});
//
//     let finalResponse = '';
//     let iterationCount = 0;
//     const maxIterations = 15;
//
//     try {
//         while (iterationCount < maxIterations) {
//             iterationCount++;
//
//             const aiResponse = await askGemini(sessionId);
//
//             if (aiResponse.type === 'error') {
//                 finalResponse = aiResponse.text;
//                 break;
//             }
//
//             if (aiResponse.type === 'text') {
//                 // AI предоставил окончательный текстовый ответ
//                 finalResponse = aiResponse.text;
//                 chatHistory.push({role: 'model', parts: [{text: aiResponse.text}]});
//                 break;
//             }
//
//             if (aiResponse.type === 'tool_call') {
//                 // Добавляем сообщение о вызове инструмента
//                 chatHistory.push({
//                     role: 'model',
//                     parts: [{
//                         functionCall: {
//                             name: aiResponse.toolName,
//                             args: aiResponse.toolArgs
//                         }
//                     }]
//                 });
//
//                 // Добавляем ответное сообщение инструмента
//                 chatHistory.push({
//                     role: 'user',
//                     parts: [{
//                         functionResponse: {
//                             name: aiResponse.toolName,
//                             response: {result: aiResponse.toolResult}
//                         }
//                     }]
//                 });
//
//                 // Продолжаем цикл, чтобы получить следующий ответ
//                 continue;
//             }
//         }
//
//         if (iterationCount >= maxIterations) {
//             finalResponse = "I've reached the maximum number of tool calls. Let me provide you with what I've found so far.";
//         }
//
//         // Обрезаем историю чата, если она становится слишком длинной
//         if (chatHistory.length > 30) {
//             // Сохраняем первые системные сообщения
//             const systemMessages = chatHistory.slice(0, 2);
//             // Сохраняем последние N сообщений
//             const recentMessages = chatHistory.slice(-28);
//             chatSessions.set(sessionId, [...systemMessages, ...recentMessages]);
//         }
//
//         res.json({ response: finalResponse });
//     } catch (error) {
//         console.error('Error processing chat request:', error);
//         res.status(500).json({ error: 'Internal server error' });
//     }
// });
//
// // Эндпоинт для очистки сессии
// app.post('/clear-session', (req, res) => {
//     const { sessionId } = req.body;
//
//     if (!sessionId || !chatSessions.has(sessionId)) {
//         return res.status(400).json({ error: 'Invalid session ID' });
//     }
//
//     chatSessions.delete(sessionId);
//     res.json({ success: true });
// });














// сколько у меня техник
// сколько дефектов у техники с номером 023WS02
// сколько дефектов у техники с номером 320AU07
// которая из моих техник ломается чаще всего
// какая модель у техники с номером 023WS02
// какой бренд у техники с номером 023WS02
// какой бренд у техники с номером 023WS02