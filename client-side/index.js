import {config} from 'dotenv';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {SSEClientTransport} from '@modelcontextprotocol/sdk/client/sse.js';
import {GoogleGenAI} from "@google/genai";
import express from 'express';
import cors from 'cors';
import http from 'http';
import {Server} from 'socket.io';
import {authorize} from './authMiddleware.js';


config();

const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;
const accessKey = process.env.ACCESS_KEY;
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

let apiKey = process.env.GEMINI_API_KEY;

if (!apiKey) {
    console.error('Error: Gemini API key not found. Please add it to your .env file.');
    process.exit(1);
}

const ai = new GoogleGenAI({apiKey});

let tools = [];

const chatSessions = new Map();

const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

let workspaceID = ""

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
                    apiKey = process.env.GEMINI_API_KEY_1;
            }
            return {
                type: 'error',
                text: 'Something went wrong with limits try again please'
            };

        }
        return {
            type: 'error',
            text: 'Sorry, I encountered an error while processing your request.'
        };
    }
}

// CLIENT - Updated connection logic
mcpClient.connect(new SSEClientTransport(new URL(`http://localhost:3001/sse?authorization=${encodeURIComponent(accessKey)}`))).then(async () => {
    console.log('Connected to MCP server');

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

        server.listen(PORT, () => {
            console.log(`HTTP server running at http://localhost:${PORT}`);
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
        await authorize(accessToken, workspaceID);
        workspaceMap.set(socket.id, workspace);
        next();
    } catch (err) {
        next(new Error('Unauthorized'));
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
        const userInput = message + ` {workspace_id: '${workspace}'}`;
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

                    continue;
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