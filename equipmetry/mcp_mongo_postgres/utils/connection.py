import asyncpg
import os

class DatabaseConnection:
    instance = None
    
    def __init__(self):
        self.pool = None

    @staticmethod
    def get_instance():
        if not DatabaseConnection.instance:
            DatabaseConnection.instance = DatabaseConnection()
        return DatabaseConnection.instance

    async def connect(self, connection_string):
        if self.pool:
            await self.disconnect()

        # Configure SSL based on environment
        if os.environ.get('NODE_ENV') == 'production':
            ssl_config = 'require'  # Equivalent to { rejectUnauthorized: false }
        else:
            ssl_config = False

        self.pool = await asyncpg.create_pool(
            connection_string,
            ssl=ssl_config
        )

        # Проверяем соединение
        async with self.pool.acquire() as client:
            pass  # Connection acquired and will be released automatically

        print('Connected to PostgreSQL')

    async def disconnect(self):
        if self.pool:
            await self.pool.close()
            self.pool = None
            print('Disconnected from PostgreSQL')

    async def query(self, text, params=None):
        if params is None:
            params = []
            
        if not self.pool:
            raise Exception('Database not connected')

        async with self.pool.acquire() as connection:
            result = await connection.fetch(text, *params)
            # Convert asyncpg Records to dictionaries to match pg.js behavior
            return [dict(row) for row in result]
