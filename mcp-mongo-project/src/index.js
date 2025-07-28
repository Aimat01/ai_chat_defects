import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {z} from "zod";
import MongoDBService from "./services/mongo-mcp-service.js";
import { PostgresMcpService } from './services/postgres-mcp-service.js';


const accessKey = process.env.ACCESS_KEY;

const server = new McpServer({
    name: "mongo-postgres-mcp-server",
    version: "1.0.0"
});

// Initialize MongoDB service
const mongoService = new MongoDBService();
const postgresService = new PostgresMcpService();

// Connect to MongoDB when starting the server
(async () => {
    try {
        await mongoService.connect();
    } catch (error) {
        console.error("Failed to connect to MongoDB:", error);
        process.exit(1);
    }
})();

// Connect to PostgreSQL when starting the server
(async () => {
    try {
        await postgresService.connect();
        console.log("PostgreSQL MCP server connected successfully");
    } catch (error) {
        console.error("Failed to connect to PostgreSQL:", error);
        process.exit(1);
    }
})();


const app = express();

// MongoDB Find Documents Tool
server.tool(
    "findDocuments",
    "Найти и получить документы из коллекции MongoDB. Используйте это, когда нужно увидеть фактическое содержимое документов или искать по определенным критериям. Для подсчета с фильтрами используйте этот инструмент вместо countDocuments.",
    {
        collection: z.string().describe("Название коллекции для запроса (например, 'defects', 'equipments', 'brands')"),
        query: z.record(z.any()).describe("Объект фильтра запроса для соответствия документов").optional().default({}),
        options: z.object({
            limit: z.number().optional().describe("Максимальное количество возвращаемых документов (по умолчанию: без ограничения)"),
            skip: z.number().optional().describe("Количество документов для пропуска при пагинации"),
            sort: z.record(z.number()).optional().describe("Критерии сортировки: {field: 1} для возрастания, {field: -1} для убывания"),
            projection: z.record(z.number()).optional().describe("Поля для включения (1) или исключения (0): {'name': 1, '_id': 0}")
        }).optional().default({})
    },
    async (arg) => {
        try {
            const { collection, query, options } = arg;
            const results = await mongoService.find(collection, query, options);

            return {
                content: [
                    {
                        type: "text",
                        text: `Найдено ${results.length} документов в коллекции '${collection}'\n${JSON.stringify(results, null, 2)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка поиска документов: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB Find One Document Tool
server.tool(
    "findOneDocument",
    "Найти один документ в коллекции MongoDB. Используйте это, когда нужен ровно один документ по ID или определенным критериям.",
    {
        collection: z.string().describe("Название коллекции для запроса"),
        query: z.record(z.any()).describe("Фильтр запроса для поиска документа"),
        options: z.object({
            projection: z.record(z.number()).optional().describe("Поля для включения или исключения в результате")
        }).optional().default({})
    },
    async (arg) => {
        try {
            const { collection, query, options } = arg;
            const result = await mongoService.findOne(collection, query, options);

            return {
                content: [
                    {
                        type: "text",
                        text: result
                            ? `Найден документ в коллекции '${collection}':\n${JSON.stringify(result, null, 2)}`
                            : `Документ не найден в коллекции '${collection}' по заданному запросу`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка поиска документа: ${error.message}`
                    }
                ]
            };
        }
    }
);

server.tool(
    "aggregateDocuments",
    "Выполнить агрегационный конвейер на коллекции MongoDB. Используйте это для сложных запросов, таких как группировка, подсчет по полям, поиск макс/мин значений и т.д.",
    {
        collection: z.string().describe("Название коллекции для выполнения агрегации"),
        pipeline: z.array(z.record(z.any())).describe("Этапы агрегационного конвейера MongoDB. Пример: [{'$group': {'_id': '$field', 'count': {'$sum': 1}}}, {'$sort': {'count': -1}}]")
    },
    async (arg) => {
        try {
            const { collection, pipeline } = arg;
            const results = await mongoService.aggregate(collection, pipeline);

            let responseText = `Агрегация коллекции '${collection}' вернула ${results.length} результатов`;

            if (results.length > 0) {
                responseText += `:\n${JSON.stringify(results, null, 2)}`;

                if (results[0].count !== undefined || results[0]._id !== undefined) {
                    responseText += `\n\nСводка:`;
                    results.slice(0, 5).forEach((result, index) => {
                        if (result._id && result.count !== undefined) {
                            responseText += `\n${index + 1}. ID: ${result._id} - Количество: ${result.count}`;
                        }
                    });

                    if (results.length > 5) {
                        responseText += `\n... и еще ${results.length - 5} результатов`;
                    }
                }
            } else {
                responseText += `. Ни один документ не соответствует критериям агрегации.`;
            }

            return {
                content: [
                    {
                        type: "text",
                        text: responseText
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка выполнения агрегации: ${error.message}\nИспользованный конвейер: ${JSON.stringify(arg.pipeline, null, 2)}`
                    }
                ]
            };
        }
    }
);

server.tool(
    "countDocuments",
    "Подсчитать документы в коллекции MongoDB. ВАЖНО: Всегда используйте параметр 'query' для фильтрации документов при подсчете определенных подмножеств.",
    {
        collection: z.string().describe("Название коллекции для подсчета документов"),
        query: z.record(z.any()).describe("ОБЯЗАТЕЛЬНЫЙ объект фильтра для подсчета определенных документов").default({})
    },
    async (arg) => {
        try {
            const { collection, query } = arg;
            const count = await mongoService.countDocuments(collection, query);

            return {
                content: [
                    {
                        type: "text",
                        text: `Найдено ${count} документов в коллекции '${collection}', соответствующих запросу: ${JSON.stringify(query)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка подсчета документов: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB List Collections Tool
server.tool(
    "listCollections",
    "Показать все коллекции в базе данных для понимания структуры базы данных",
    {},
    async () => {
        try {
            const collections = await mongoService.listCollections();

            return {
                content: [
                    {
                        type: "text",
                        text: `Найдено ${collections.length} коллекций в базе данных`
                    },
                    {
                        type: "text",
                        text: JSON.stringify(collections, null, 2)
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка получения списка коллекций: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB Collection Schema Tool
server.tool(
    "getCollectionSchema",
    "Проанализировать структуру и типы полей коллекции MongoDB для понимания доступных полей для запросов",
    {
        collection: z.string().describe("Название коллекции для анализа"),
        sampleSize: z.number().optional().default(5).describe("Количество документов для выборки при анализе схемы")
    },
    async (arg) => {
        try {
            const { collection, sampleSize } = arg;

            // Check if a collection exists first
            const collections = await mongoService.listCollections();
            if (!collections.includes(collection)) {
                return {
                    content: [
                        {
                            type: "text",
                            text: `Коллекция '${collection}' не существует в базе данных.`
                        },
                        {
                            type: "text",
                            text: `Доступные коллекции: ${JSON.stringify(collections, null, 2)}`
                        }
                    ]
                };
            }

            const schemaInfo = await mongoService.getCollectionSchema(collection, sampleSize);

            const fieldsCount = Object.keys(schemaInfo.schema).length;

            return {
                content: [
                    {
                        type: "text",
                        text: `Анализ схемы коллекции '${collection}' (проанализировано ${schemaInfo.documentCount} документов)`
                    },
                    {
                        type: "text",
                        text: `Найдено ${fieldsCount} полей в схеме`
                    },
                    {
                        type: "text",
                        text: JSON.stringify(schemaInfo.schema, null, 2)
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка получения схемы коллекции '${arg.collection}': ${error.message}`
                    }
                ]
            };
        }
    }
);


// Sample Data Tool
server.tool(
    "getSampleData",
    "Получить примеры документов из коллекции для понимания структуры данных и типов полей. Полезно для отладки проблем с запросами.",
    {
        collection: z.string().describe("Название коллекции для выборки"),
        limit: z.number().optional().default(5).describe("Количество возвращаемых примеров документов"),
        fields: z.array(z.string()).optional().describe("Конкретные поля для отображения (оставьте пустым для всех полей)")
    },
    async (arg) => {
        try {
            const { collection, limit, fields } = arg;

            let projection = {};
            if (fields && fields.length > 0) {
                fields.forEach(field => projection[field] = 1);
            }

            const samples = await mongoService.find(collection, {}, {
                limit,
                projection: Object.keys(projection).length > 0 ? projection : {}
            });

            return {
                content: [
                    {
                        type: "text",
                        text: `Примеры ${samples.length} документов из коллекции '${collection}':\n${JSON.stringify(samples, null, 2)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка получения примеров данных: ${error.message}`
                    }
                ]
            };
        }
    }
);

server.tool(
    "findRelationshipsBetweenCollections",
    "Анализирует две коллекции MongoDB и определяет возможные связи между ними, такие как внешние ключи.",
    {
        collection1: z.string().describe("Название первой коллекции для анализа"),
        collection2: z.string().describe("Название второй коллекции для анализа"),
        schema1: z.record(z.any()).describe("Схема первой коллекции"),
        schema2: z.record(z.any()).describe("Схема второй коллекции"),
        sampleSize: z.number().optional().default(5).describe("Количество документов для выборки при проверке связей")
    },
    async (args) => {
        try {
            const { collection1, collection2, schema1, schema2, sampleSize } = args;
            const result = await mongoService.findRelationshipBetweenCollections(collection1, collection2, schema1, schema2, sampleSize);

            return {
                content: [
                    {
                        type: "text",
                        text: result
                            ? `Найдены связи между коллекциями '${collection1}' и '${collection2}':\n${JSON.stringify(result, null, 2)}`
                            : `Связи между коллекциями '${collection1}' и '${collection2}' не найдены.`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка анализа связей: ${error.message}`
                    }
                ]
            };
        }
    }
);

// POSTGRES MCP TOOLS
// Execute Query Tool (SELECT operations)
server.tool(
    "pg_execute_query",
    "Выполнить SELECT запросы и операции получения данных. Используйте это для SELECT, WITH конструкций и других операций чтения.",
    {
        operation: z.enum(['select', 'count', 'exists']).describe('Операция запроса: select (получить строки), count (подсчитать строки), exists (проверить существование)'),
        query: z.string().describe('SQL SELECT запрос для выполнения'),
        parameters: z.array(z.unknown()).optional().default([]).describe('Значения параметров для заполнителей подготовленного оператора ($1, $2, и т.д.)'),
        limit: z.number().optional().describe('Максимальное количество возвращаемых строк (ограничение безопасности)'),
        timeout: z.number().optional().describe('Таймаут запроса в миллисекундах')
    },
    async (args) => {
        try {
            const { operation, query, parameters = [], limit, timeout } = args;

            // Validate query is a SELECT-like operation
            const trimmedQuery = query.trim().toLowerCase();
            if (!trimmedQuery.startsWith('select') && !trimmedQuery.startsWith('with')) {
                throw new McpError(ErrorCode.InvalidParams, 'Запрос должен быть оператором SELECT или CTE (WITH конструкция)');
            }

            let finalQuery = query;

            // Apply limit if specified and not already in query
            if (limit && !trimmedQuery.includes('limit')) {
                finalQuery += ` LIMIT ${limit}`;
            }

            let result;
            switch (operation) {
                case 'select': {
                    const rows = await postgresService.executeQuery(finalQuery, parameters);
                    result = {
                        operation: 'select',
                        rowCount: rows.length,
                        rows: rows
                    };
                    break;
                }

                case 'count': {
                    const countQuery = `SELECT COUNT(*) as total FROM (${query}) as subquery`;
                    const countResult = await postgresService.executeQuery(countQuery, parameters);
                    result = {
                        operation: 'count',
                        rowCount: 1,
                        result: countResult[0]?.total || 0
                    };
                    break;
                }

                case 'exists': {
                    const existsQuery = `SELECT EXISTS (${query}) as exists`;
                    const existsResult = await postgresService.executeQuery(existsQuery, parameters);
                    result = {
                        operation: 'exists',
                        rowCount: 1,
                        result: existsResult[0]?.exists || false
                    };
                    break;
                }
            }

            let responseText = '';
            switch (operation) {
                case 'select':
                    responseText = `Запрос выполнен успешно. Получено ${result.rowCount} строк.\n\nРезультаты:\n${JSON.stringify(result.rows, null, 2)}`;
                    break;
                case 'count':
                    responseText = `Запрос подсчета выполнен успешно. Всего строк: ${result.result}`;
                    break;
                case 'exists':
                    responseText = `Запрос существования выполнен успешно. Результат: ${result.result ? 'СУЩЕСТВУЕТ' : 'НЕ СУЩЕСТВУЕТ'}`;
                    break;
            }

            return {
                content: [
                    {
                        type: "text",
                        text: responseText
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка выполнения ${args.operation} запроса: ${error.message}`
                    }
                ]
            };
        }
    }
);


// Get Schema Info Tool
server.tool(
    "pg_get_schema_info",
    "Получить информацию о схеме базы данных или конкретной таблицы. Используйте это для понимания структуры таблицы.",
    {
        connectionString: z.string().optional().describe('Строка подключения PostgreSQL (необязательно)'),
        tableName: z.string().optional().describe("Необязательное имя таблицы для получения подробной схемы")
    },
    async (args) => {
        try {
            const { connectionString, tableName } = args;

            if (connectionString) {
                await postgresService.connect(connectionString);
            }

            const result = await postgresService.getSchemaInfo(tableName);

            const message = tableName
                ? `Информация о схеме таблицы ${tableName}`
                : 'Список таблиц в базе данных';

            return {
                content: [
                    {
                        type: "text",
                        text: message
                    },
                    {
                        type: "text",
                        text: JSON.stringify(result, null, 2)
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка получения информации о схеме: ${error.message}`
                    }
                ]
            };
        }
    }
);

server.tool(
    "pg_get_sample_data",
    "Получить примеры строк из таблицы PostgreSQL для понимания структуры данных",
    {
        connectionString: z.string().optional(),
        tableName: z.string().describe("Имя таблицы для выборки"),
        limit: z.number().optional().default(3).describe("Количество возвращаемых примеров строк"),
        columns: z.array(z.string()).optional().describe("Конкретные столбцы для отображения (оставьте пустым для всех столбцов)")
    },
    async (args) => {
        try {
            const { connectionString, tableName, limit, columns } = args;

            if (connectionString) {
                await postgresService.connect(connectionString);
            }

            const samples = await postgresService.getSampleData(tableName, limit, columns);

            return {
                content: [
                    {
                        type: "text",
                        text: `Примеры ${samples.length} строк из таблицы '${tableName}':\n${JSON.stringify(samples, null, 2)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка получения примеров данных: ${error.message}`
                    }
                ]
            };
        }
    }
);

server.tool(
    "pg_analyze_relationships",
    "Проанализировать взаимосвязи между таблицами PostgreSQL на основе внешних ключей",
    {
        connectionString: z.string().optional(),
        includeImplicitRelations: z.boolean().optional().default(false).describe("Также искать неявные взаимосвязи на основе шаблонов именования столбцов")
    },
    async (args) => {
        try {
            const { connectionString, includeImplicitRelations } = args;

            if (connectionString) {
                await postgresService.connect(connectionString);
            }

            const relationships = await postgresService.analyzeRelationships(includeImplicitRelations);

            return {
                content: [
                    {
                        type: "text",
                        text: "Анализ взаимосвязей таблиц PostgreSQL:"
                    },
                    {
                        type: "text",
                        text: JSON.stringify(relationships, null, 2)
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Ошибка анализа взаимосвязей: ${error.message}`
                    }
                ]
            };
        }
    }
);

const transports = {};

const sessionKeys = new Map();

// Updated SSE endpoint
app.get("/sse", async (req, res) => {
    const providedKey = req.query.authorization;


    if (!providedKey || providedKey !== accessKey) {
        return res.status(401).json({ error: 'Unauthorized: invalid access key' });
    }
    try {
        const transport = new SSEServerTransport('/messages', res);

        transports[transport.sessionId] = transport;

        sessionKeys.set(transport.sessionId, providedKey);

        res.on("close", () => {
            delete transports[transport.sessionId];
            sessionKeys.delete(transport.sessionId);
        });

        await server.connect(transport);
    } catch (error) {
        res.status(500).json({ error: 'Failed to establish SSE connection' });
    }
});

app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;

    const storedKey = sessionKeys.get(sessionId);

    if (!storedKey || storedKey !== accessKey) {
        return res.status(401).json({ error: 'Unauthorized: invalid session' });
    }

    const transport = transports[sessionId];
    if (transport) {
        try {
            await transport.handlePostMessage(req, res);
        } catch (error) {
            console.error('Error handling POST message:', error);
            res.status(500).json({ error: 'Failed to handle message' });
        }
    } else {
        console.log('No transport found for sessionId:', sessionId);
        res.status(400).json({ error: 'No transport found for sessionId' });
    }
});

app.listen(3001, () => {
    console.log('MCP MongoDB server running on port 3001');
});