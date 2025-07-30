import {config} from 'dotenv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import express from 'express';
import http from 'http';
import {Server} from 'socket.io';
import {authorize} from './authMiddleware.js';
import fetch from 'node-fetch';

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

// Ключи API для OpenRouter
const openRouterApiKey = process.env.OPENROUTER_API_KEY;

if (!openRouterApiKey) {
    console.error('Error: OpenRouter API key not found. Please add it to your .env file.');
    process.exit(1);
}

// Инструменты сразу в формате OpenRouter
let formattedTools = [];

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
equipments содержит информацию о технике, включая: ее статус(status) (BROKEN, IDLE)
-equipment_history — история изменений статуса техники (по equipment_id) если вопрос касательно в каком проекте или секторе работает техниа то используй это коллекцию тут храняться id
также содержит технический и эксплуатационный статус техники(exploitation_status, technical_status) 
    пользователи должны видеть только технику, которая относится к их workspace_id
- defects — поломки, неисправности (по equipment_id)
- tickets — заявки на ремонт (по equipment_id)
- brand, models — марка и модель техники
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
ИСОПЛЬЗУЙ mongo-postgres-mcp-server для выполнения запросов к базе данных.
Если пользователь четко не указывает дату или не говорит за сегодня ищи данные за все время`

const mcpClient = new Client({
    name: 'mongodb-gemini-chatbot',
    version: "1.0.0",
    requestTimeoutMs: 120000
});

// Simplified and corrected askAI function for OpenRouter + Gemini
async function askAI(sessionId) {
    try {
        const messages = chatSessions.get(sessionId);

        // Clean up messages - ensure they follow OpenAI format
        const cleanMessages = messages.map(msg => {
            if (msg.role === 'user') {
                return {
                    role: 'user',
                    content: msg.content || ''
                };
            } else if (msg.role === 'assistant') {
                const cleanMsg = {
                    role: 'assistant',
                    content: msg.content
                };

                // Include tool calls if present
                if (msg.tool_calls) {
                    cleanMsg.tool_calls = msg.tool_calls;
                }

                return cleanMsg;
            } else if (msg.role === 'tool') {
                return {
                    role: 'tool',
                    tool_call_id: msg.tool_call_id,
                    content: msg.content
                };
            } else if (msg.role === 'system') {
                return {
                    role: 'system',
                    content: msg.content || ''
                };
            }

            return null;
        }).filter(msg => msg !== null);

        const requestBody = {
            model: 'google/gemini-2.5-flash',
            messages: cleanMessages,
            temperature: 0.7,
            max_tokens: 2048
        };

        // Add tools if available
        if (formattedTools.length > 0) {
            requestBody.tools = formattedTools;
            requestBody.tool_choice = "auto";
        }


        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${openRouterApiKey}`,
                'HTTP-Referer': 'http://localhost:3000',
                'X-Title': 'MongoDB-Qwen-Chatbot'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API error: ${response.status} - ${JSON.stringify(errorData)}`);
        }

        const responseData = await response.json();

        if (!responseData || !responseData.choices || !responseData.choices.length) {
            console.error('Invalid response structure:', responseData);
            return {
                type: 'error',
                text: 'Получен некорректный ответ от API'
            };
        }

        const assistantMessage = responseData.choices[0].message;

        if (!assistantMessage) {
            console.error('No message in response:', responseData.choices[0]);
            return {
                type: 'error',
                text: 'Сообщение не найдено в ответе API'
            };
        }

        // Handle tool calls
        if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
            const toolCall = assistantMessage.tool_calls[0];
            console.log(`🔧 Session ${sessionId} - Tool used:`, toolCall.function.name);
            console.log(`🔧 Session ${sessionId} - Tool arguments:`, toolCall.function.arguments);

            const args = JSON.parse(toolCall.function.arguments);

            const toolResponse = await mcpClient.callTool({
                name: toolCall.function.name,
                arguments: args
            });

            let toolResult = "No content received from tool";
            if (toolResponse.content && toolResponse.content.length > 0) {
                toolResult = toolResponse.content[0].text;
            }

            return {
                type: 'tool_call',
                toolName: toolCall.function.name,
                toolArgs: args,
                toolResult: toolResult,
                toolCallId: toolCall.id // Important for proper conversation flow
            };
        } else if (assistantMessage.content) {
            return {
                type: 'text',
                text: assistantMessage.content
            };
        }
        console.error('No content in assistant message:', assistantMessage);
        return {
            type: 'text',
            text: 'Нет ответа от ИИ'
        };

    } catch (error) {
        console.error('Error in askAI:', error);

        if (error.message.includes('rate limit') || error.message.includes('429')) {
            return {
                type: 'error',
                text: 'Превышен лимит запросов к API. Пожалуйста, попробуйте позже.'
            };
        }

        return {
            type: 'error',
            text: 'Извините, произошла ошибка при обработке вашего запроса: ' + error.message
        };
    }
}
// CLIENT - Updated connection logic
const serverUrl = process.env.SERVER_URL || 'http://77.240.38.113:3001';
mcpClient.connect(new SSEClientTransport(new URL(`${serverUrl}/sse?authorization=${encodeURIComponent(accessKey)}`))).then(async () => {
    console.log('Connected to MCP server');
    try {
        const toolsList = await mcpClient.listTools();
        formattedTools = toolsList.tools.map(tool => {
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
                type: "function",
                function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: {
                        type: tool.inputSchema.type,
                        properties: cleanProperties,
                        required: tool.inputSchema.required || []
                    }
                }
            };
        });

        console.log('Available tools:', formattedTools.map(tool => tool.function.name).join(', '));

        server.listen(PORT, '0.0.0.0', () => {
            console.log(`HTTP server running at http://0.0.0.0:${PORT}`);
        });
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

    try {
        await authorize(accessToken, workspace);
        workspaceMap.set(socket.id, workspace);
        next();
    } catch (err) {
        console.error('Данные сокета:', {
            id: socket.id,
            headers: socket.handshake.headers
        });
        next(new Error('Unauthorized: ' + (err.message || 'Неизвестная ошибка')));
    }
});

io.on('connection', (socket) => {
    const sessionId = socket.id;
    // Храним историю чата сразу в формате OpenRouter
    const initialChatHistory = [
        {role: 'user', content: SYSTEM_PROMPT},
        {role: 'assistant', content: 'Понятно! Я буду правильно использовать фильтры запросов для поиска связанных данных в MongoDB и собирать всю необходимую информацию для предоставления исчерпывающих ответов.'}
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
        const userInput = message.userMessage + ` {workspace_id: '${workspace}', date: '${new Date().toISOString()}'}`;
        const messages = chatSessions.get(sessionId);

        // Add user message
        messages.push({role: 'user', content: userInput});

        let finalResponse = '';
        let iterationCount = 0;
        const maxIterations = 15;

        try {
            while (iterationCount < maxIterations) {
                iterationCount++;

                const aiResponse = await askAI(sessionId);
                if (aiResponse.type === 'error') {
                    finalResponse = aiResponse.text;
                    break;
                }

                if (aiResponse.type === 'text') {
                    finalResponse = aiResponse.text;
                    messages.push({role: 'assistant', content: aiResponse.text});
                    break;
                }

                if (aiResponse.type === 'tool_call') {
                    socket.emit('tool_call', {
                        tool: aiResponse.toolName,
                        args: aiResponse.toolArgs
                    });

                    // Add assistant message with tool call (proper format)
                    messages.push({
                        role: 'assistant',
                        content: null,
                        tool_calls: [{
                            id: aiResponse.toolCallId || 'call_' + Math.random().toString(36).substring(2, 15),
                            type: 'function',
                            function: {
                                name: aiResponse.toolName,
                                arguments: JSON.stringify(aiResponse.toolArgs)
                            }
                        }]
                    });

                    // Add tool response with matching ID
                    const toolCallId = aiResponse.toolCallId || 'call_' + Math.random().toString(36).substring(2, 15);
                    messages.push({
                        role: 'tool',
                        tool_call_id: toolCallId,
                        content: JSON.stringify({result: aiResponse.toolResult})
                    });
                }
            }

            if (iterationCount >= maxIterations) {
                finalResponse = "Извините, запрос слишком сложный. Попробуйте переформулировать его или уточнить детали.";
            }

            // Memory management - keep conversation manageable
            if (messages.length > 50) {
                const systemMessages = messages.slice(0, 2);
                const recentMessages = messages.slice(-20);
                chatSessions.set(sessionId, [...systemMessages, ...recentMessages]);
            }

            socket.emit('chat_response', {response: finalResponse});

        } catch (error) {
            console.error('Error in chat message handler:', error);
            socket.emit('error', {error: 'Internal server error'});
        }
    });

    socket.on('disconnect', () => {
        if (chatSessions.has(sessionId)) {
            chatSessions.delete(sessionId);
        }
    });
});

// сколько у меня техник
// сколько дефектов у техники с номером 023WS02
// сколько дефектов у техники с номером 320AU07
// которая из моих техник ломается чаще всего
// какая модель у техники с номером 023WS02
// какой бренд у техники с номером 023WS02
// какой бренд у техники с номером 023WS02