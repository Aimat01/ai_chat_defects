from decimal import Decimal
import sys
import os
import re
import uuid
from typing import Optional, List, Dict, Any, Union
from dotenv import load_dotenv
from bson import ObjectId
import asyncpg
from asyncpg.pool import Pool

sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..')))

# Import from relative paths - adjust these based on your actual module structure
from utils.connection import DatabaseConnection

from enum import Enum

class ErrorCode(Enum):
    """
    Перечисление кодов ошибок, аналогичное TypeScript enum.
    """
    # Общие ошибки
    INVALID_INPUT = "INVALID_INPUT"
    UNAUTHORIZED = "UNAUTHORIZED"
    NOT_FOUND = "NOT_FOUND"
    SERVER_ERROR = "SERVER_ERROR"
    
    # Специфичные ошибки протокола
    PROTOCOL_VIOLATION = "PROTOCOL_VIOLATION"
    TIMEOUT = "TIMEOUT"
    InternalError = "INTERNAL_ERROR"


class McpError(Exception):
    """
    Кастомный класс исключения для ошибок Model Context Protocol.
    Содержит код ошибки и дополнительную информацию.
    """
    def __init__(self, code: ErrorCode, message: str, details: any = None):
        """
        Конструктор ошибки.
        
        :param code: Код ошибки из перечисления ErrorCode.
        :param message: Человекочитаемое описание ошибки.
        :param details: Дополнительные данные (опционально).
        """
        # Вызываем конструктор родительского класса Exception
        super().__init__(message)
        
        # Сохраняем наши кастомные поля
        self.code = code
        self.details = details

    def __str__(self):
        """
        Возвращает строковое представление ошибки для удобного вывода.
        """
        return f"McpError(code={self.code.name}, message='{self.args[0]}')"

load_dotenv()

class PostgresMcpService:
    def __init__(self):
        self.db = DatabaseConnection.get_instance()

    def add_workspace_filter_to_query(self, query: str, workspace_id: str = None) -> str:
        """Добавляет фильтр workspace_id к SQL запросу"""
        if not workspace_id:
            return query
            
        # Конвертируем workspace_id в UUID если это ObjectId
        workspace_uuid = self.convert_to_uuid(workspace_id)
        if not workspace_uuid:
            return query
            
        # Приводим запрос к нижнему регистру для анализа
        lower_query = query.lower().strip()
        
        # Проверяем, содержит ли запрос уже workspace_id фильтр
        if 'workspace_id' in lower_query:
            return query
            
        # Находим основную таблицу в FROM клаузуле
        from_match = re.search(r'\bfrom\s+(\w+)', lower_query)
        if not from_match:
            return query
            
        main_table = from_match.group(1)
        
        # Добавляем фильтр по workspace_id
        if 'where' in lower_query:
            # Если WHERE уже есть, добавляем AND условие
            where_pos = lower_query.find('where')
            before_where = query[:where_pos + 5]  # включаем 'WHERE'
            after_where = query[where_pos + 5:]
            
            # Добавляем условие в начало WHERE клаузулы
            modified_query = f"{before_where} {main_table}.workspace_id = '{workspace_uuid}' AND {after_where}"
        else:
            # Если WHERE нет, добавляем его
            # Ищем позицию для вставки WHERE (перед ORDER BY, GROUP BY, HAVING, LIMIT)
            insert_pos = len(query)
            for clause in ['order by', 'group by', 'having', 'limit']:
                pos = lower_query.find(clause)
                if pos != -1 and pos < insert_pos:
                    insert_pos = pos
                    
            before_clause = query[:insert_pos].strip()
            after_clause = query[insert_pos:] if insert_pos < len(query) else ''
            
            modified_query = f"{before_clause} WHERE {main_table}.workspace_id = '{workspace_uuid}' {after_clause}"
            
        return modified_query

    async def connect(self, connection_string: Optional[str] = None):
        resolved_connection_string = connection_string or os.environ.get('POSTGRES_URL')
        await self.db.connect(resolved_connection_string)

    async def disconnect(self):
        await self.db.disconnect()

    def clean_result_for_json(self, data):
        """Очищает результат от объектов, не сериализуемых в JSON"""
        if isinstance(data, list):
            return [self.clean_result_for_json(item) for item in data]
        elif isinstance(data, dict):
            return {key: self.clean_result_for_json(value) for key, value in data.items()}
        elif isinstance(data, uuid.UUID):
            return str(data)
        elif isinstance(data, Decimal):
            return float(data)
        else:
            return data

    # Execute SELECT queries
    async def execute_query(self, query: str, parameters: List[Any] = None, options: Dict[str, Any] = None, workspace_id: str = None):
        if parameters is None:
            parameters = []
        if options is None:
            options = {}
            
        try:
            # Добавляем фильтр по workspace_id
            query = self.add_workspace_filter_to_query(query, workspace_id)
            
            query = self.process_uuids(query)
            limit = options.get('limit')
            offset = options.get('offset')
            final_query = query

            if limit:
                final_query += f" LIMIT {limit}"
            if offset:
                final_query += f" OFFSET {offset}"

            result = await self.db.query(final_query, parameters)
    
            # Очищаем результат перед возвратом
            clean_result = self.clean_result_for_json(result)
            return clean_result
        except Exception as error:
            raise McpError(ErrorCode.InternalError, f"Query execution failed: {str(error)}")

    # Get schema information
    async def get_schema_info(self, table_name: Optional[str] = None):
        try:
            if table_name:
                return await self.get_table_info(table_name)

            tables = await self.db.query(
                """SELECT table_name
                 FROM information_schema.tables
                 WHERE table_schema = 'common_data'
                   AND table_type = 'BASE TABLE'
                 ORDER BY table_name"""
            )

            result = [t['table_name'] for t in tables]
        
            return self.clean_result_for_json(result)
        except Exception as error:
            raise McpError(ErrorCode.InternalError, f"Schema info retrieval failed: {str(error)}")

    async def get_table_info(self, table_name: str):
        try:
            # Get column information
            columns = await self.db.query(
                """SELECT column_name, data_type, is_nullable, column_default
                 FROM information_schema.columns
                 WHERE table_schema = 'common_data'
                   AND table_name = $1
                 ORDER BY ordinal_position""",
                [table_name]
            )

            result = {
                'tableName': table_name,
                'columns': [
                    {
                        'name': col['column_name'],
                        'dataType': col['data_type'],
                        'nullable': col['is_nullable'] == 'YES',
                        'default': col['column_default']
                    }
                    for col in columns
                ]
            }
        
            return self.clean_result_for_json(result)
        except Exception as error:
            raise McpError(ErrorCode.InternalError, f"Table info retrieval failed: {str(error)}")

    async def get_sample_data(self, table_name: str, limit: int = 5, columns: Optional[List[str]] = None, workspace_id: str = None):
        try:
            column_list = ', '.join(columns) if columns and len(columns) > 0 else '*'
            query = f"SELECT {column_list} FROM {table_name}"
            
            # Добавляем фильтр workspace_id
            if workspace_id:
                workspace_uuid = self.convert_to_uuid(workspace_id)
                if workspace_uuid:
                    query += f" WHERE workspace_id = '{workspace_uuid}'"
            
            query += f" LIMIT {limit}"

            samples = await self.execute_query(query, [])
            
            return self.clean_result_for_json(samples)
        except Exception as error:
            raise McpError(ErrorCode.InternalError, f"Sample data retrieval failed: {str(error)}")

    async def analyze_relationships(self, include_implicit_relations: bool = False):
        try:
            foreign_keys = await self.execute_query("""
                SELECT tc.table_name   as from_table,
                       kcu.column_name as from_column,
                       ccu.table_name  as to_table,
                       ccu.column_name as to_column,
                       tc.constraint_name
                FROM information_schema.table_constraints AS tc
                         JOIN information_schema.key_column_usage AS kcu
                              ON tc.constraint_name = kcu.constraint_name
                         JOIN information_schema.constraint_column_usage AS ccu
                              ON ccu.constraint_name = tc.constraint_name
                WHERE tc.constraint_type = 'FOREIGN KEY'
                  AND tc.table_schema = 'common_data'
            """)

            from_tables = [fk['from_table'] for fk in foreign_keys]
            to_tables = [fk['to_table'] for fk in foreign_keys]
            connected_tables = list(set(from_tables + to_tables))

            relationships = {
                'explicitRelationships': foreign_keys,
                'summary': {
                    'totalForeignKeys': len(foreign_keys),
                    'connectedTables': len(connected_tables)
                }
            }

            return self.clean_result_for_json(relationships)
        except Exception as error:
            raise McpError(ErrorCode.InternalError, f"Relationship analysis failed: {str(error)}")
        
    async def get_vehicle_data(self, license_plate: str, workspace_id: str = None) -> dict:
        """Получить данные техники - ИСПРАВЛЕНО"""
        
        # Очистка номера
        license_plate = license_plate.strip().upper()
        
        # SQL с встроенным workspace_id
        if workspace_id:
            workspace_uuid = self.convert_to_uuid(workspace_id)
            query = """
                SELECT
                    license_plate_number,
                    MAX(mileage) as current_mileage,
                    MAX(enginehours) as current_enginehours,
                    MAX(motohours) as current_motohours,
                    managers,
                    project,
                    brand,
                    model
                FROM common_data.daily_history_wfd
                WHERE license_plate_number = $1 AND workspace_id = $2
                GROUP BY license_plate_number, managers, project, brand, model
                ORDER BY MAX(stat_date) DESC
                LIMIT 1
            """
            parameters = [license_plate, workspace_uuid]
        else:
            query = """
                SELECT
                    license_plate_number,
                    MAX(mileage) as current_mileage,
                    MAX(enginehours) as current_enginehours,
                    MAX(motohours) as current_motohours,
                    managers,
                    project,
                    brand,
                    model
                FROM common_data.daily_history_wfd
                WHERE license_plate_number = $1
                GROUP BY license_plate_number, managers, project, brand, model
                ORDER BY MAX(stat_date) DESC
                LIMIT 1
            """
            parameters = [license_plate]
        
        try:
            # КРИТИЧНО: Используем self.db.query напрямую!
            # НЕ используем self.execute_query - это избегает двойной обработки
            result = await self.db.query(query, parameters)
            
            if result and len(result) > 0:
                vehicle_data = result[0]
                return self.clean_result_for_json({
                    "license_plate": vehicle_data.get('license_plate_number'),
                    "mileage": vehicle_data.get('current_mileage'),
                    "engine_hours": vehicle_data.get('current_enginehours'),
                    "moto_hours": vehicle_data.get('current_motohours'),
                    "managers": vehicle_data.get('managers'),
                    "project": vehicle_data.get('project'),
                    "brand": vehicle_data.get('brand'),
                    "model": vehicle_data.get('model'),
                    "found": True
                })
            else:
                return {
                    "license_plate": license_plate,
                    "mileage": None,
                    "engine_hours": None,
                    "moto_hours": None,
                    "managers": None,
                    "project": None,
                    "brand": None,
                    "model": None,
                    "found": False,
                    "error": f"Данные для техники {license_plate} не найдены"
                }
        except Exception as e:
            import traceback
            print(f"❌ ERROR in get_vehicle_data:")
            print(f"   License plate: {license_plate}")
            print(f"   Workspace: {workspace_id}")
            print(f"   Error: {str(e)}")
            print(traceback.format_exc())
            
            raise McpError(
                ErrorCode.InternalError, 
                f"Failed to get vehicle data for {license_plate}: {str(e)}"
            )
    
    def process_uuids(self, query: str):
        if not query or not isinstance(query, str):
            return query

        id_regex = re.compile(r'(\b(?:_?id|[a-z_]+_id)\s*=\s*[\'"])([0-9a-fA-F]{24})([\'"])', re.IGNORECASE)

        # Заменяем найденные идентификаторы на их UUID эквиваленты
        def replace_match(match):
            prefix = match.group(1)
            id_value = match.group(2)
            suffix = match.group(3)
            uuid_value = self.convert_to_uuid(id_value)
            if uuid_value:
                return f"{prefix}{uuid_value}{suffix}"
            return match.group(0)

        processed_query = id_regex.sub(replace_match, query)
        return processed_query

    def convert_to_uuid(self, value: Union[str, ObjectId, Dict[str, Any]]) -> Optional[str]:
        # Если это ObjectId, преобразуем в строку
        if isinstance(value, ObjectId):
            value = str(value)
        # Если это объект с $oid полем (формат EJSON)
        elif value and isinstance(value, dict) and '$oid' in value:
            value = value['$oid']

        # Если у нас строка, создаём UUID v5 на основе неё
        if isinstance(value, str):
            # Константа NAMESPACE_DNS в формате UUID
            NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
            return str(uuid.uuid5(uuid.UUID(NAMESPACE_DNS), value))

        return None