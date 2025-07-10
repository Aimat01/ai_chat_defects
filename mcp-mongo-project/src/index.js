import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {z} from "zod";
import MongoDBService from "./services/mcp-service.js";

const server = new McpServer({
    name: "example-server",
    version: "1.0.0"
});

// Initialize MongoDB service
const mongoService = new MongoDBService();

// Connect to MongoDB when starting the server
(async () => {
    try {
        await mongoService.connect();
    } catch (error) {
        console.error("Failed to connect to MongoDB:", error);
        process.exit(1);
    }
})();

const app = express();

// MongoDB Find Documents Tool - обновленный
server.tool(
    "findDocuments",
    "Find and retrieve documents from a MongoDB collection. Use this when you need to see actual document content or search with specific criteria. For counting with filters, use this tool instead of countDocuments.",
    {
        collection: z.string().describe("The collection name to query (e.g., 'defects', 'equipments', 'brands')"),
        query: z.record(z.any()).describe("The query filter object to match documents. Examples: {'equipment_id': '665ec912c81eefbf37c8e18a'} for defects by equipment, {'_id': 'some_id'} for specific document, {} for all documents").optional().default({}),
        options: z.object({
            limit: z.number().optional().describe("Maximum number of documents to return (default: no limit)"),
            skip: z.number().optional().describe("Number of documents to skip for pagination"),
            sort: z.record(z.number()).optional().describe("Sort criteria: {field: 1} for ascending, {field: -1} for descending"),
            projection: z.record(z.number()).optional().describe("Fields to include (1) or exclude (0): {'name': 1, '_id': 0}")
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
                        text: `Found ${results.length} documents in collection '${collection}'\n${JSON.stringify(results, null, 2)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error finding documents: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB Find One Document Tool - обновленный
server.tool(
    "findOneDocument",
    "Find a single document in a MongoDB collection. Use this when you need exactly one document by ID or specific criteria.",
    {
        collection: z.string().describe("The collection name to query"),
        query: z.record(z.any()).describe("The query filter to find the document. Example: {'_id': 'document_id'} or {'name': 'specific_name'}"),
        options: z.object({
            projection: z.record(z.number()).optional().describe("Fields to include or exclude in the result")
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
                            ? `Found document in collection '${collection}':\n${JSON.stringify(result, null, 2)}`
                            : `No document found in collection '${collection}' matching the query`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error finding document: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB Aggregation Tool - УЛУЧШЕННАЯ ВЕРСИЯ
server.tool(
    "aggregateDocuments",
    "Run aggregation pipeline on a MongoDB collection. Use this for complex queries like grouping, counting by field, finding max/min values, etc.",
    {
        collection: z.string().describe("The collection name to run aggregation on"),
        pipeline: z.array(z.record(z.any())).describe("MongoDB aggregation pipeline stages. Example: [{'$group': {'_id': '$field', 'count': {'$sum': 1}}}, {'$sort': {'count': -1}}]")
    },
    async (arg) => {
        try {
            const { collection, pipeline } = arg;
            const results = await mongoService.aggregate(collection, pipeline);
            
            // Создаем более информативный ответ
            let responseText = `Aggregation on collection '${collection}' returned ${results.length} results`;
            
            if (results.length > 0) {
                responseText += `:\n${JSON.stringify(results, null, 2)}`;
                
                // Если это группировка с подсчетом, добавим краткую сводку
                if (results[0].count !== undefined || results[0]._id !== undefined) {
                    responseText += `\n\nSummary:`;
                    results.slice(0, 5).forEach((result, index) => {
                        if (result._id && result.count !== undefined) {
                            responseText += `\n${index + 1}. ID: ${result._id} - Count: ${result.count}`;
                        }
                    });
                    
                    if (results.length > 5) {
                        responseText += `\n... and ${results.length - 5} more results`;
                    }
                }
            } else {
                responseText += `. No documents matched the aggregation criteria.`;
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
                        text: `Error running aggregation: ${error.message}\nPipeline used: ${JSON.stringify(arg.pipeline, null, 2)}`
                    }
                ]
            };
        }
    }
);

// MongoDB Count Documents Tool - ИСПРАВЛЕННАЯ ВЕРСИЯ
server.tool(
    "countDocuments",
    "Count documents in a MongoDB collection. IMPORTANT: Always use the 'query' parameter to filter documents when counting specific subsets. For example, to count defects for a specific equipment, use query: {'equipment_id': 'equipment_id_value'}",
    {
        collection: z.string().describe("The collection name to count documents in"),
        query: z.record(z.any()).describe("REQUIRED filter object to count specific documents. Examples: {'equipment_id': '665ec912c81eefbf37c8e18a'} to count defects for specific equipment, {'status': 'active'} to count active items, {} for all documents").default({})
    },
    async (arg) => {
        try {
            const { collection, query } = arg;
            const count = await mongoService.countDocuments(collection, query);
            
            // Возвращаем только один content item с полным результатом
            return {
                content: [
                    {
                        type: "text",
                        text: `Found ${count} documents in collection '${collection}' matching query: ${JSON.stringify(query)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error counting documents: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB List Collections Tool
server.tool(
    "listCollections",
    "List all collections in the database to understand the database structure",
    {},
    async () => {
        try {
            const collections = await mongoService.listCollections();
            
            return {
                content: [
                    {
                        type: "text",
                        text: `Found ${collections.length} collections in the database`
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
                        text: `Error listing collections: ${error.message}`
                    }
                ]
            };
        }
    }
);

// MongoDB Collection Schema Tool
server.tool(
    "getCollectionSchema",
    "Analyze the structure and field types of a MongoDB collection to understand what fields are available for querying",
    {
        collection: z.string().describe("The collection name to analyze"),
        sampleSize: z.number().optional().default(100).describe("Number of documents to sample for schema analysis")
    },
    async (arg) => {
        try {
            const { collection, sampleSize } = arg;
            const schemaInfo = await mongoService.getCollectionSchema(collection, sampleSize);
            
            const fieldsCount = Object.keys(schemaInfo.schema).length;
            
            return {
                content: [
                    {
                        type: "text",
                        text: `Schema analysis for collection '${collection}' (sampled ${schemaInfo.documentCount} documents)`
                    },
                    {
                        type: "text", 
                        text: `Found ${fieldsCount} fields in the schema`
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
                        text: `Error getting schema for collection '${arg.collection}': ${error.message}`
                    }
                ]
            };
        }
    }
);

// NEW: Helper tool to guide AI about relationships
server.tool(
    "getDatabaseInfo",
    "Get helpful information about common database relationships and query patterns. Use this to understand how to query related data.",
    {},
    async () => {
        const info = {
            "common_relationships": {
                "defects_to_equipments": "defects collection has 'equipment_id' field that references equipments._id",
                "equipments_to_brands": "equipments collection has 'brand_id' field that references brands._id", 
                "equipments_to_workspaces": "equipments collection has 'workspace_id' field that references workspaces._id"
            },
            "query_examples": {
                "count_defects_by_equipment": "countDocuments('defects', {'equipment_id': 'equipment_id_value'})",
                "find_equipment_by_brand": "findDocuments('equipments', {'brand_id': 'brand_id_value'})",
                "get_equipment_details": "findOneDocument('equipments', {'_id': 'equipment_id'})"
            },
            "tips": [
                "Always use query filters when looking for specific relationships",
                "Use findDocuments when you need actual data, countDocuments when you just need counts",
                "Check collection schemas first if you're unsure about field names"
            ]
        };

        return {
            content: [
                {
                    type: "text",
                    text: "Database relationship information and query guidance:"
                },
                {
                    type: "text",
                    text: JSON.stringify(info, null, 2)
                }
            ]
        };
    }
);

// NEW: Sample Data Tool для отладки
server.tool(
    "getSampleData",
    "Get sample documents from a collection to understand data structure and field types. Useful for debugging query issues.",
    {
        collection: z.string().describe("The collection name to sample"),
        limit: z.number().optional().default(3).describe("Number of sample documents to return"),
        fields: z.array(z.string()).optional().describe("Specific fields to show (leave empty for all fields)")
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
                        text: `Sample ${samples.length} documents from collection '${collection}':\n${JSON.stringify(samples, null, 2)}`
                    }
                ]
            };
        } catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error getting sample data: ${error.message}`
                    }
                ]
            };
        }
    }
);

const transports = {};

app.get("/sse", async (req, res) => {
    const transport = new SSEServerTransport('/messages', res);
    transports[transport.sessionId] = transport;
    res.on("close", () => {
        delete transports[transport.sessionId];
    });
    await server.connect(transport);
});

app.post("/messages", async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];
    if (transport) {
        await transport.handlePostMessage(req, res);
    } else {
        res.status(400).send('No transport found for sessionId');
    }
});

// Clean up MongoDB connection on server shutdown
process.on('SIGINT', async () => {
    try {
        await mongoService.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }
});

app.listen(3001, () => {
    console.log('MCP MongoDB server running on port 3001');
});