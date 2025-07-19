import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {z} from "zod";
import MongoDBService from "./services/mongo-mcp-service.js";
import { PostgresMcpService } from './services/postgres-mcp-service.js';

const server = new McpServer({
    name: "example-server",
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
    "Find and retrieve documents from a MongoDB collection. Use this when you need to see actual document content or search with specific criteria. For counting with filters, use this tool instead of countDocuments.",
    {
        collection: z.string().describe("The collection name to query (e.g., 'defects', 'equipments', 'brands')"),
        query: z.record(z.any()).describe("The query filter object to match documents.").optional().default({}),
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

// MongoDB Find One Document Tool
server.tool(
    "findOneDocument",
    "Find a single document in a MongoDB collection. Use this when you need exactly one document by ID or specific criteria.",
    {
        collection: z.string().describe("The collection name to query"),
        query: z.record(z.any()).describe("The query filter to find the document."),
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
            
            let responseText = `Aggregation on collection '${collection}' returned ${results.length} results`;
            
            if (results.length > 0) {
                responseText += `:\n${JSON.stringify(results, null, 2)}`;
                
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

server.tool(
    "countDocuments",
    "Count documents in a MongoDB collection. IMPORTANT: Always use the 'query' parameter to filter documents when counting specific subsets.",
    {
        collection: z.string().describe("The collection name to count documents in"),
        query: z.record(z.any()).describe("REQUIRED filter object to count specific documents.").default({})
    },
    async (arg) => {
        try {
            const { collection, query } = arg;
            const count = await mongoService.countDocuments(collection, query);
            
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
        sampleSize: z.number().optional().default(5).describe("Number of documents to sample for schema analysis")
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
                            text: `Collection '${collection}' does not exist in the database.`
                        },
                        {
                            type: "text",
                            text: `Available collections: ${JSON.stringify(collections, null, 2)}`
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


// Sample Data Tool
server.tool(
    "getSampleData",
    "Get sample documents from a collection to understand data structure and field types. Useful for debugging query issues.",
    {
        collection: z.string().describe("The collection name to sample"),
        limit: z.number().optional().default(5).describe("Number of sample documents to return"),
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

// POSTGRES MCP TOOLS
// Execute Query Tool (SELECT operations)
server.tool(
    "pg_execute_query",
    "Execute SELECT queries and data retrieval operations. Use this for SELECT, WITH clauses, and other read operations.",
    {
        operation: z.enum(['select', 'count', 'exists']).describe('Query operation: select (fetch rows), count (count rows), exists (check existence)'),
        query: z.string().describe('SQL SELECT query to execute'),
        parameters: z.array(z.unknown()).optional().default([]).describe('Parameter values for prepared statement placeholders ($1, $2, etc.)'),
        limit: z.number().optional().describe('Maximum number of rows to return (safety limit)'),
        timeout: z.number().optional().describe('Query timeout in milliseconds')
    },
    async (args) => {
        try {
            const { operation, query, parameters = [], limit, timeout } = args;

            // Validate query is a SELECT-like operation
            const trimmedQuery = query.trim().toLowerCase();
            if (!trimmedQuery.startsWith('select') && !trimmedQuery.startsWith('with')) {
                throw new McpError(ErrorCode.InvalidParams, 'Query must be a SELECT statement or CTE (WITH clause)');
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
                    responseText = `Query executed successfully. Retrieved ${result.rowCount} rows.\n\nResults:\n${JSON.stringify(result.rows, null, 2)}`;
                    break;
                case 'count':
                    responseText = `Count query executed successfully. Total rows: ${result.result}`;
                    break;
                case 'exists':
                    responseText = `Exists query executed successfully. Result: ${result.result ? 'EXISTS' : 'NOT EXISTS'}`;
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
                        text: `Error executing ${args.operation} query: ${error.message}`
                    }
                ]
            };
        }
    }
);


// Get Schema Info Tool
server.tool(
    "pg_get_schema_info",
    "Get schema information for a database or specific table. Use this to understand table structure.",
    {
        connectionString: z.string().optional().describe('PostgreSQL connection string (optional)'),
        tableName: z.string().optional().describe("Optional table name to get detailed schema for")
    },
    async (args) => {
        try {
            const { connectionString, tableName } = args;

            if (connectionString) {
                await postgresService.connect(connectionString);
            }

            const result = await postgresService.getSchemaInfo(tableName);

            const message = tableName
                ? `Schema information for table ${tableName}`
                : 'List of tables in database';

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
                        text: `Error getting schema info: ${error.message}`
                    }
                ]
            };
        }
    }
);

server.tool(
    "pg_get_sample_data",
    "Get sample rows from a PostgreSQL table to understand data structure",
    {
        connectionString: z.string().optional(),
        tableName: z.string().describe("Table name to sample"),
        limit: z.number().optional().default(3).describe("Number of sample rows to return"),
        columns: z.array(z.string()).optional().describe("Specific columns to show (leave empty for all columns)")
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
                        text: `Sample ${samples.length} rows from table '${tableName}':\n${JSON.stringify(samples, null, 2)}`
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

server.tool(
    "pg_analyze_relationships",
    "Analyze relationships between PostgreSQL tables based on foreign keys",
    {
        connectionString: z.string().optional(),
        includeImplicitRelations: z.boolean().optional().default(false).describe("Also look for implicit relationships based on column naming patterns")
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
                        text: "PostgreSQL table relationships analysis:"
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
                        text: `Error analyzing relationships: ${error.message}`
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
        await postgresService.disconnect();
        process.exit(0);
    } catch (error) {
        console.error('Error during shutdown:', error);
        process.exit(1);
    }

});

app.listen(3001, () => {
    console.log('MCP MongoDB server running on port 3001');
});