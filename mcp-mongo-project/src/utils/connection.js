import pkg from 'pg';
const { Pool } = pkg;

export class DatabaseConnection {
    constructor() {
        this.pool = null;
    }

    static getInstance() {
        if (!DatabaseConnection.instance) {
            DatabaseConnection.instance = new DatabaseConnection();
        }
        return DatabaseConnection.instance;
    }

    async connect(connectionString) {
        if (this.pool) {
            await this.disconnect();
        }

        this.pool = new Pool({
            connectionString,
            ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
        });

        // Проверяем соединение
        const client = await this.pool.connect();
        client.release();

        console.log('Connected to PostgreSQL');
    }

    async disconnect() {
        if (this.pool) {
            await this.pool.end();
            this.pool = null;
            console.log('Disconnected from PostgreSQL');
        }
    }

    async query(text, params = []) {
        if (!this.pool) {
            throw new Error('Database not connected');
        }

        const result = await this.pool.query(text, params);
        return result.rows;
    }
}