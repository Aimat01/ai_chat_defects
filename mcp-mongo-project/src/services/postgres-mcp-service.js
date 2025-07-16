import { DatabaseConnection } from '../utils/connection.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

dotenv.config();

export class PostgresMcpService {
    constructor() {
        this.db = DatabaseConnection.getInstance();
    }

    getConnectionString(connectionString) {
        if (connectionString) {
            return connectionString;
        }

        const envConnectionString = process.env.POSTGRES_URL;
        if (envConnectionString) {
            return envConnectionString;
        }

        // Build connection string from individual env variables
        const host = process.env.POSTGRES_HOST || 'localhost';
        const port = process.env.POSTGRES_PORT || '5432';
        const database = process.env.POSTGRES_DB;
        const username = process.env.POSTGRES_USER;
        const password = process.env.POSTGRES_PASSWORD;

        if (!database || !username || !password) {
            throw new Error('PostgreSQL connection parameters are not defined');
        }

        return `postgresql://${username}:${password}@${host}:${port}/${database}`;
    }

    async connect(connectionString) {
        const resolvedConnectionString = this.getConnectionString(connectionString);
        await this.db.connect(resolvedConnectionString);
    }

    async disconnect() {
        await this.db.disconnect();
    }

    // Execute SELECT queries
    async executeQuery(query, parameters = [], options = {}) {
        try {
            const { limit, offset } = options;
            let finalQuery = query;

            if (limit) {
                finalQuery += ` LIMIT ${limit}`;
            }
            if (offset) {
                finalQuery += ` OFFSET ${offset}`;
            }

            const result = await this.db.query(finalQuery, parameters);
            return result;
        } catch (error) {
            throw new McpError(ErrorCode.InternalError, `Query execution failed: ${error.message}`);
        }
    }

    // Get schema information
    async getSchemaInfo(tableName) {
        try {
            if (tableName) {
                return await this.getTableInfo(tableName);
            }

            const tables = await this.db.query(
                `SELECT table_name FROM information_schema.tables 
                 WHERE table_schema = 'common_data' AND table_type = 'BASE TABLE' 
                 ORDER BY table_name`
            );

            return tables.map(t => t.table_name);
        } catch (error) {
            throw new McpError(ErrorCode.InternalError, `Schema info retrieval failed: ${error.message}`);
        }
    }

    async getTableInfo(tableName) {
        try {
            // Get column information
            const columns = await this.db.query(
                `SELECT column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = 'common_data' AND table_name = $1
                 ORDER BY ordinal_position`,
                [tableName]
            );

            // Get constraint information
            const constraints = await this.db.query(
                `SELECT
                   c.conname as constraint_name,
                   CASE
                     WHEN c.contype = 'p' THEN 'PRIMARY KEY'
                     WHEN c.contype = 'f' THEN 'FOREIGN KEY'
                     WHEN c.contype = 'u' THEN 'UNIQUE'
                     WHEN c.contype = 'c' THEN 'CHECK'
                     ELSE c.contype::text
                   END as constraint_type,
                   pg_get_constraintdef(c.oid) as definition
                 FROM pg_constraint c
                 JOIN pg_namespace n ON n.oid = c.connamespace
                 JOIN pg_class cl ON cl.oid = c.conrelid
                 WHERE n.nspname = 'common_data' AND cl.relname = $1`,
                [tableName]
            );

            const indexes = await this.db.query(
                `SELECT indexname, indexdef
             FROM pg_indexes
             WHERE tablename = $1 AND schemaname = 'common_data'`,
                [tableName]
            );

            return {
                tableName,
                columns: columns.map(col => ({
                    name: col.column_name,
                    dataType: col.data_type,
                    nullable: col.is_nullable === 'YES',
                    default: col.column_default
                })),
                constraints: constraints.map(con => ({
                    name: con.constraint_name,
                    type: con.constraint_type,
                    definition: con.definition
                })),
                indexes: indexes.map(idx => ({
                    name: idx.indexname,
                    definition: idx.indexdef
                }))
            };
        } catch (error) {
            throw new McpError(ErrorCode.InternalError, `Table info retrieval failed: ${error.message}`);
        }
    }


    async getSampleData(tableName, limit = 3, columns = null) {
        try {
            const columnList = columns && columns.length > 0 ? columns.join(', ') : '*';
            const query = `SELECT ${columnList} FROM ${tableName} LIMIT $1`;

            const samples = await this.executeQuery(query, [limit]);
            return samples;
        } catch (error) {
            throw new McpError(ErrorCode.InternalError, `Sample data retrieval failed: ${error.message}`);
        }
    }

    async analyzeRelationships(includeImplicitRelations = false) {
        try {
            const foreignKeys = await this.executeQuery(`
            SELECT
                tc.table_name as from_table,
                kcu.column_name as from_column,
                ccu.table_name as to_table,
                ccu.column_name as to_column,
                tc.constraint_name
            FROM information_schema.table_constraints AS tc
            JOIN information_schema.key_column_usage AS kcu
                ON tc.constraint_name = kcu.constraint_name
            JOIN information_schema.constraint_column_usage AS ccu
                ON ccu.constraint_name = tc.constraint_name
            WHERE tc.constraint_type = 'FOREIGN KEY'
                AND tc.table_schema = 'common_data'
        `);

            const relationships = {
                explicitRelationships: foreignKeys,
                summary: {
                    totalForeignKeys: foreignKeys.length,
                    connectedTables: [...new Set([...foreignKeys.map(fk => fk.from_table), ...foreignKeys.map(fk => fk.to_table)])].length
                }
            };

            return relationships;
        } catch (error) {
            throw new McpError(ErrorCode.InternalError, `Relationship analysis failed: ${error.message}`);
        }
    }
}