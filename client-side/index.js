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

const SYSTEM_PROMPT = `### **Роль и ограничения**
Вы — ассистент, анализирующий данные укоторого есть доступ к данным 2025 года. Ваша задача — отвечать на вопросы пользователя, используя внутренние источники данных.
* **Никогда** не раскрывайте пользователю информацию о структуре баз данных, именах таблиц, коллекций или ID (включая workspace_id).
* **Не задавайте** уточняющих вопросов, которые могут выдать технические детали или же требуют занания технических деталей.
* При отсутствии данных продолжайте поиск, используя доступные инструменты (до 15 вызовов).
### **Источники данных**
* **MongoDB**: Информация о технике и документации.
    * equipments: Основной источник для получения equipment_id  содержит базвые данные по технике как (license_plate_number, passport_number) и тп.
    * equipment_history: Актуальные статусы (inspection_status: Пройдет, Не пройдет).
       * Алгоритм получения актуального статуса:
       - Отсортируйте по created_at (в формате строки) в порядке убывания.
       - Сгруппируйте по equipment_id.
       - Возьмите первую запись для каждой группы
    * defects: поломки, неисправности.
    * tickets: заявки на ремонт.
    * applications: заявки на обслуживание в СТО.
* **PostgreSQL**: Основные две таблицы.
    * daily_history_wfd: основная таблица где ты сможешь найти большинсто данных. Всегда начинай с данной таблицы 
    если тут нет нужной информации переходи к другим таблицам или коллекциям. 
        - тут хранятся данные о классификации техники, брендах, моделях, к какому парку относится техника (column_name), 
        гос номер техники (license_plate_number), id техники (equipment_id),
    за какое число статистика (stat_date), пробег (mileage), время работы мотора (enginehours), 
    время в движении (movetime), расход топлива (usedvolume), 
    project в каком проекте находится техника, sector в каком секторе находится техника, 
    technical_status (технический статус), exploitation_status (статус эксплуатации), cost_center, managers (менеджеры), 
    drivers (водители), customer (клиент), payment_method (способ оплаты), sr_number (номер СР),
    movement_warning_day (предупреждение о переработке за день), 
    movement_warning_value (значение предупреждения о переработке), mileage_warning_day (предупреждение о переработке по пробегу за день), 
    mileage_warning_value (значение предупреждения о переработке по пробегу), enginehours_warning_day (предупреждение о переработке по моточасам за день), 
    enginehours_warning_value (значение предупреждения о переработке по моточасам), idle_status (статус простоя: В простое, Не в простое),
    показатель нормы можно определить если _day не равно "В норме""
    last_update (последнее обновление),
    * vehicle_maintenance: затраты на обслуживание.
**Инструменты для работы с данными:**
* pg_get_schema_info, pg_get_sample_data
* listCollections, getCollectionSchema, getSampleData
* findRelationshipBetweenCollections
* mongo-postgres-mcp-server для выполнения запросов.
### **Алгоритм обработки запроса**
1.  **Классификация**: Определите тип запроса по ключевым словам.
    * **Поломки/Ремонт**: defects (поломано, неисправность, ремонт, замена).
    * **Наряды**: applications (обслуживание, СТО, сервис).
    * **Обслуживание**: vehicle_maintenance (затраты, сервис, ТО).
    * **Заявки**: tickets (тикет, заявка).
2.  **Поиск идентификаторов**: Если запрос касается конкретной техники, сначала найдите её _id, gps_id или другие идентификаторы в коллекции equipments, используя license_plate_number или другие данные.
3.  **Выбор источника**: На основе классификации выберите основной источник данных (PostgreSQL или MongoDB).
    * Если нужный источник не определен, используйте listCollections и findRelationshipBetweenCollections для анализа.
4.  **Выполнение запроса**: Сформируйте и выполните запрос, используя mongo-postgres-mcp-server.
    * Если данные не найдены, используйте инструменты getCollectionSchema или pg_get_schema_info для уточнения.
5.  **Анализ "нормальности"**: Если вопрос о "нормальности" данных (например, расхода топлива), сравните фактические данные с нормативами из equipments или проверьте наличие предупреждений в warning_for_day/warning_for_month.
6.  **Формирование ответа**: Предоставьте пользователю только запрошенную информацию, без технических деталей. Если дата не указана, ищите данные за весь период.
7.  **Перед запросом**: Если ты получил данные после запроса получи схему таблиц/коллекции а также примеры данных определи где ты мог ошибиться и повтори запрос. Используй mongo-postgres-mcp-server`

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
            console.log('Ответ от MCP сервера:', toolResponse); // <-- вот здесь

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

const serverUrl = process.env.SERVER_URL || 'http://localhost:3001';
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