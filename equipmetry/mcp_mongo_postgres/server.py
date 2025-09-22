import asyncio
import json
import os
import sys
import uuid
import re
from typing import Dict, Optional, Any, List
from dataclasses import dataclass
from enum import Enum

# Web framework
from flask import Flask, request, Response, jsonify
from flask_cors import CORS

# Validation
from pydantic import BaseModel, Field
from typing_extensions import Annotated

# For SSE functionality
import queue
import threading
import time
from werkzeug.serving import WSGIRequestHandler

# Import the real services
from services.mongo_service import MongoDBService
from services.postgres_service import PostgresMcpService


# Global event loop для всех async операций
_loop = None
_loop_thread = None

def get_event_loop():
    global _loop, _loop_thread
    if _loop is None or _loop.is_closed():
        def run_loop():
            global _loop
            _loop = asyncio.new_event_loop()
            asyncio.set_event_loop(_loop)
            _loop.run_forever()
        
        _loop_thread = threading.Thread(target=run_loop, daemon=True)
        _loop_thread.start()
        
        # Ждем пока loop запустится
        while _loop is None:
            time.sleep(0.01)
    
    return _loop

def run_async(coro):
    loop = get_event_loop()
    future = asyncio.run_coroutine_threadsafe(coro, loop)
    return future.result(timeout=30)

def extract_workspace_id_from_args(arguments):
    """Извлекает workspace_id из аргументов и удаляет его из arguments"""
    workspace_id = None
    
    # Проверяем в основных аргументах
    if 'workspace_id' in arguments:
        workspace_id = arguments.pop('workspace_id')  # Удаляем, чтобы не мешал валидации
    
    # Проверяем в query
    if 'query' in arguments and isinstance(arguments['query'], dict):
        if 'workspace_id' in arguments['query']:
            workspace_id = arguments['query'].pop('workspace_id')  # Удаляем из query тоже
    
    # Если не найден, ищем в тексте (например, в user_input)
    if not workspace_id:
        for key, value in arguments.items():
            if isinstance(value, str) and 'workspace_id:' in value:
                # Извлекаем workspace_id из строки типа "workspace_id: '60a...'}"
                match = re.search(r"workspace_id[:\s]*['\"]([^'\"]+)['\"]", value)
                if match:
                    workspace_id = match.group(1)
                    break
    
    return workspace_id

# Pydantic models for validation (same as before, unchanged)
class FindDocumentsOptions(BaseModel):
    limit: Optional[int] = Field(None, description="Максимальное количество возвращаемых документов (по умолчанию: без ограничения)")
    skip: Optional[int] = Field(None, description="Количество документов для пропуска при пагинации")
    sort: Optional[Dict[str, int]] = Field(None, description="Критерии сортировки: {field: 1} для возрастания, {field: -1} для убывания")
    projection: Optional[Dict[str, int]] = Field(None, description="Поля для включения (1) или исключения (0): {'name': 1, '_id': 0}")

class FindDocumentsArgs(BaseModel):
    collection: str = Field(..., description="Название коллекции для запроса (например, 'defects', 'equipments', 'brands')")
    query: Dict[str, Any] = Field(default_factory=dict, description="Объект фильтра запроса для соответствия документов")
    options: FindDocumentsOptions = Field(default_factory=FindDocumentsOptions)

class FindOneDocumentOptions(BaseModel):
    projection: Optional[Dict[str, int]] = Field(None, description="Поля для включения или исключения в результате")

class FindOneDocumentArgs(BaseModel):
    collection: str = Field(..., description="Название коллекции для запроса")
    query: Dict[str, Any] = Field(..., description="Фильтр запроса для поиска документа")
    options: FindOneDocumentOptions = Field(default_factory=FindOneDocumentOptions)

class AggregateDocumentsArgs(BaseModel):
    collection: str = Field(..., description="Название коллекции для выполнения агрегации")
    pipeline: List[Dict[str, Any]] = Field(..., description="Этапы агрегационного конвейера MongoDB. Пример: [{'$group': {'_id': '$field', 'count': {'$sum': 1}}}, {'$sort': {'count': -1}}]")

class CountDocumentsArgs(BaseModel):
    collection: str = Field(..., description="Название коллекции для подсчета документов")
    query: Dict[str, Any] = Field(default_factory=dict, description="Объект фильтра для подсчета определенных документов")

class GetCollectionSchemaArgs(BaseModel):
    collection: str = Field(..., description="Название коллекции для анализа")
    sampleSize: int = Field(default=5, description="Количество документов для выборки при анализе схемы")

class GetSampleDataArgs(BaseModel):
    collection: str = Field(..., description="Название коллекции для выборки")
    limit: int = Field(default=5, description="Количество возвращаемых примеров документов")
    fields: Optional[List[str]] = Field(None, description="Конкретные поля для отображения (оставьте пустым для всех полей)")

class FindRelationshipsArgs(BaseModel):
    collection1: str = Field(..., description="Название первой коллекции для анализа")
    collection2: str = Field(..., description="Название второй коллекции для анализа")
    schema1: Dict[str, Any] = Field(..., description="Схема первой коллекции")
    schema2: Dict[str, Any] = Field(..., description="Схема второй коллекции")
    sampleSize: int = Field(default=5, description="Количество документов для выборки при проверке связей")

class PostgresOperation(str, Enum):
    SELECT = 'select'
    COUNT = 'count'
    EXISTS = 'exists'

class PostgresQueryArgs(BaseModel):
    operation: PostgresOperation = Field(..., description='Операция запроса: select (получить строки), count (подсчитать строки), exists (проверить существование)')
    query: str = Field(..., description='SQL SELECT запрос для выполнения')
    parameters: List[Any] = Field(default_factory=list, description='Значения параметров для заполнителей подготовленного оператора ($1, $2, и т.д.)')
    limit: Optional[int] = Field(None, description='Максимальное количество возвращаемых строк (ограничение безопасности)')
    timeout: Optional[int] = Field(None, description='Таймаут запроса в миллисекундах')

class PostgresSchemaArgs(BaseModel):
    connectionString: Optional[str] = Field(None, description='Строка подключения PostgreSQL (необязательно)')
    tableName: Optional[str] = Field(None, description="Необязательное имя таблицы для получения подробной схемы")

class PostgresSampleDataArgs(BaseModel):
    connectionString: Optional[str] = Field(None)
    tableName: str = Field(..., description="Имя таблицы для выборки")
    limit: int = Field(default=3, description="Количество возвращаемых примеров строк")
    columns: Optional[List[str]] = Field(None, description="Конкретные столбцы для отображения (оставьте пустым для всех столбцов)")

class PostgresRelationshipsArgs(BaseModel):
    connectionString: Optional[str] = Field(None)
    includeImplicitRelations: bool = Field(default=False, description="Также искать неявные взаимосвязи на основе шаблонов именования столбцов")

# Get access key from environment
access_key = os.environ.get('ACCESS_KEY')

# Initialize services
mongo_service = MongoDBService()
postgres_service = PostgresMcpService()

async def init_connections():
    """Initialize database connections"""
    try:
        await mongo_service.connect()
        print("MongoDB service connected successfully")
    except Exception as error:
        print(f"Failed to connect to MongoDB: {error}")
        sys.exit(1)
    
    try:
        await postgres_service.connect()
        print("PostgreSQL service connected successfully")
    except Exception as error:
        print(f"Failed to connect to PostgreSQL: {error}")
        sys.exit(1)

# Create Flask app
app = Flask(__name__)
CORS(app)

@app.route('/', methods=['GET'])
def health_check():
    return jsonify({"status": "healthy", "message": "MCP server is running"})

@app.route('/tools', methods=['GET'])
def list_tools():
    return jsonify({
        "tools": [
            {
                "name": "findDocuments",
                "description": "Найти и получить документы из коллекции MongoDB. Используйте это, когда нужно увидеть фактическое содержимое документов или искать по определенным критериям.",
                "inputSchema": FindDocumentsArgs.model_json_schema()
            },
            {
                "name": "findOneDocument", 
                "description": "Найти один документ в коллекции MongoDB. Используйте это, когда нужен ровно один документ по ID или определенным критериям.",
                "inputSchema": FindOneDocumentArgs.model_json_schema()
            },
            {
                "name": "aggregateDocuments",
                "description": "Выполнить агрегационный конвейер на коллекции MongoDB. Используйте это для сложных запросов, таких как группировка, подсчет по полям, поиск макс/мин значений и т.д.",
                "inputSchema": AggregateDocumentsArgs.model_json_schema()
            },
            {
                "name": "countDocuments",
                "description": "Подсчитать документы в коллекции MongoDB. Для подсчета всех документов используйте пустой объект query: {}",
                "inputSchema": CountDocumentsArgs.model_json_schema()
            },
            {
                "name": "listCollections",
                "description": "Показать все коллекции в базе данных для понимания структуры базы данных",
                "inputSchema": {}
            },
            {
                "name": "getCollectionSchema",
                "description": "Проанализировать структуру и типы полей коллекции MongoDB для понимания доступных полей для запросов",
                "inputSchema": GetCollectionSchemaArgs.model_json_schema()
            },
            {
                "name": "getSampleData",
                "description": "Получить примеры документов из коллекции для понимания структуры данных и типов полей. Полезно для отладки проблем с запросами.",
                "inputSchema": GetSampleDataArgs.model_json_schema()
            },
            {
                "name": "findRelationshipsBetweenCollections",
                "description": "Анализирует две коллекции MongoDB и определяет возможные связи между ними, такие как внешние ключи.",
                "inputSchema": FindRelationshipsArgs.model_json_schema()
            },
            {
                "name": "pg_execute_query",
                "description": "Выполнить SELECT запросы и операции получения данных. Используйте это для SELECT, WITH конструкций и других операций чтения.",
                "inputSchema": PostgresQueryArgs.model_json_schema()
            },
            {
                "name": "pg_get_schema_info",
                "description": "Получить информацию о схеме базы данных или конкретной таблицы. Используйте это для понимания структуры таблицы.",
                "inputSchema": PostgresSchemaArgs.model_json_schema()
            },
            {
                "name": "pg_get_sample_data",
                "description": "Получить примеры строк из таблицы PostgreSQL для понимания структуры данных",
                "inputSchema": PostgresSampleDataArgs.model_json_schema()
            },
            {
                "name": "pg_analyze_relationships",
                "description": "Проанализировать взаимосвязи между таблицами PostgreSQL на основе внешних ключей",
                "inputSchema": PostgresRelationshipsArgs.model_json_schema()
            }
        ]
    })

def preprocess_arguments(arguments):
    """Предобработка аргументов для исправления строковых JSON объектов"""
    processed_args = {}
    
    for key, value in arguments.items():
        if isinstance(value, str) and key in ['options', 'query', 'pipeline']:
            try:
                # Попробуем распарсить строку как JSON
                processed_args[key] = json.loads(value)
            except (json.JSONDecodeError, TypeError):
                # Если не получилось, оставляем как есть
                processed_args[key] = value
        else:
            processed_args[key] = value
    
    return processed_args

@app.route('/call-tool', methods=['POST'])
def call_tool():
    try:
        data = request.get_json()
        tool_name = data.get('name')
        arguments = data.get('arguments', {})
        
        # Предобрабатываем аргументы
        arguments = preprocess_arguments(arguments)
        
        # Извлекаем workspace_id из аргументов
        workspace_id = extract_workspace_id_from_args(arguments)
        
        print(f"DEBUG: Tool call - {tool_name} with args: {arguments}")
        if workspace_id:
            print(f"DEBUG: Using workspace_id: {workspace_id}")
        
        # MongoDB Tools
        if tool_name == "findDocuments":
            args = FindDocumentsArgs(**arguments)
            result = run_async(mongo_service.find(
                args.collection, 
                args.query, 
                args.options.dict(exclude_none=True) if args.options else {},
                workspace_id
            ))
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": f"Найдено {len(result)} документов в коллекции '{args.collection}'\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                }]
            })
            
        elif tool_name == "findOneDocument":
            print(f"DEBUG: Raw arguments before validation: {arguments}")
            try:
                args = FindOneDocumentArgs(**arguments)
                print(f"DEBUG: Parsed args successfully: collection={args.collection}, query={args.query}, options={args.options}")
            except Exception as e:
                print(f"DEBUG: Validation error: {e}")
                print(f"DEBUG: Arguments types: {[(k, type(v)) for k, v in arguments.items()]}")
                raise e
                
            result = run_async(mongo_service.findOne(
                args.collection, 
                args.query, 
                args.options.dict(exclude_none=True) if args.options else {},
                workspace_id
            ))
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": (f"Найден документ в коллекции '{args.collection}':\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                            if result else f"Документ не найден в коллекции '{args.collection}' по заданному запросу")
                }]
            })
            
        elif tool_name == "aggregateDocuments":
            args = AggregateDocumentsArgs(**arguments)
            result = run_async(mongo_service.aggregate(args.collection, args.pipeline, {}, workspace_id))
            response_text = f"Агрегация коллекции '{args.collection}' вернула {len(result)} результатов"
            
            if result:
                response_text += f":\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                if result and (result[0].get('count') is not None or result[0].get('_id') is not None):
                    response_text += "\n\nСводка:"
                    for index, res in enumerate(result[:5]):
                        if res.get('_id') and res.get('count') is not None:
                            response_text += f"\n{index + 1}. ID: {res['_id']} - Количество: {res['count']}"
                    if len(result) > 5:
                        response_text += f"\n... и еще {len(result) - 5} результатов"
            else:
                response_text += ". Ни один документ не соответствует критериям агрегации."
                
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": response_text
                }]
            })
            
        elif tool_name == "countDocuments":
            # Ensure query parameter exists
            if "query" not in arguments:
                arguments["query"] = {}
            args = CountDocumentsArgs(**arguments)
            result = run_async(mongo_service.countDocuments(args.collection, args.query, {}, workspace_id))
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": f"Найдено {result} документов в коллекции '{args.collection}', соответствующих запросу: {json.dumps(args.query, ensure_ascii=False)}"
                }]
            })
            
        elif tool_name == "listCollections":
            result = run_async(mongo_service.listCollections())
            return jsonify({
                "content": [
                    {
                        "type": "text",
                        "text": f"Найдено {len(result)} коллекций в базе данных"
                    },
                    {
                        "type": "text",
                        "text": json.dumps(result, indent=2, ensure_ascii=False)
                    }
                ]
            })
            
        elif tool_name == "getCollectionSchema":
            args = GetCollectionSchemaArgs(**arguments)
            result = run_async(mongo_service.getCollectionSchema(args.collection, args.sampleSize, True, workspace_id))
            return jsonify({
                "content": [
                    {
                        "type": "text",
                        "text": f"Анализ схемы коллекции '{args.collection}' (проанализировано {result.get('documentCount', 0)} документов)"
                    },
                    {
                        "type": "text",
                        "text": json.dumps(result, indent=2, ensure_ascii=False)
                    }
                ]
            })
            
        elif tool_name == "getSampleData":
            args = GetSampleDataArgs(**arguments)
            projection = {}
            if args.fields:
                for field in args.fields:
                    projection[field] = 1
                    
            result = run_async(mongo_service.find(
                args.collection, 
                {}, 
                {
                    'limit': args.limit,
                    'projection': projection if projection else {}
                },
                workspace_id
            ))
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": f"Примеры {len(result)} документов из коллекции '{args.collection}':\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                }]
            })
            
        elif tool_name == "findRelationshipsBetweenCollections":
            args = FindRelationshipsArgs(**arguments)
            result = run_async(mongo_service.findRelationshipBetweenCollections(
                args.collection1, args.collection2, args.schema1, args.schema2, args.sampleSize, workspace_id
            ))
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": (f"Найдены связи между коллекциями '{args.collection1}' и '{args.collection2}':\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                            if result else f"Связи между коллекциями '{args.collection1}' и '{args.collection2}' не найдены.")
                }]
            })
            
        # PostgreSQL Tools
        elif tool_name == "pg_execute_query":
            args = PostgresQueryArgs(**arguments)
            
            try:
                # Validate query is a SELECT-like operation
                trimmed_query = args.query.strip().lower()
                if not trimmed_query.startswith('select') and not trimmed_query.startswith('with'):
                    return jsonify({
                        "content": [{
                            "type": "text",
                            "text": "Ошибка: запрос должен быть оператором SELECT или CTE (WITH конструкция)"
                        }]
                    }), 400
                    
                final_query = args.query
                if args.limit and 'limit' not in trimmed_query:
                    final_query += f" LIMIT {args.limit}"
                    
                if args.operation == PostgresOperation.SELECT:
                    result = run_async(postgres_service.execute_query(final_query, args.parameters, {}, workspace_id))
                    response_text = f"Запрос выполнен успешно. Получено {len(result)} строк.\n\nРезультаты:\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                    
                elif args.operation == PostgresOperation.COUNT:
                    if 'count(' in trimmed_query or 'count (' in trimmed_query:
                        result = run_async(postgres_service.execute_query(final_query, args.parameters, {}, workspace_id))
                        count_value = result[0].get('count') or result[0].get('total') or (list(result[0].values())[0] if result[0] else 0)
                    else:
                        count_query = f"SELECT COUNT(*) as total FROM ({args.query}) as subquery"
                        result = run_async(postgres_service.execute_query(count_query, args.parameters, {}, workspace_id))
                        count_value = result[0].get('total', 0) if result else 0
                        
                    response_text = f"Запрос подсчета выполнен успешно. Всего строк: {count_value}"
                    
                elif args.operation == PostgresOperation.EXISTS:
                    if ('exists(' in trimmed_query or 'exists (' in trimmed_query or
                        'not exists(' in trimmed_query or 'not exists (' in trimmed_query):
                        result = run_async(postgres_service.execute_query(final_query, args.parameters, {}, workspace_id))
                        exists_value = result[0].get('exists', False) if result else False
                    else:
                        exists_query = f"SELECT EXISTS ({args.query}) as exists"
                        result = run_async(postgres_service.execute_query(exists_query, args.parameters, {}, workspace_id))
                        exists_value = result[0].get('exists', False) if result else False
                        
                    response_text = f"Запрос существования выполнен успешно. Результат: {'СУЩЕСТВУЕТ' if exists_value else 'НЕ СУЩЕСТВУЕТ'}"
                    
                return jsonify({
                    "content": [{
                        "type": "text",
                        "text": response_text
                    }]
                })
                
            except Exception as e:
                # Полное логирование ошибки
                import traceback
                full_error = traceback.format_exc()
                print(f"=== TOOL CALL ERROR ===")
                print(f"Tool: {tool_name}")
                print(f"Arguments: {arguments}")
                print(f"Error: {str(e)}")
                print(f"Full traceback:\n{full_error}")
                print(f"=== END TOOL ERROR ===")
                
                return jsonify({
                    "content": [{
                        "type": "text",
                        "text": f"Tool execution failed: {str(e)}"
                    }]
                }), 500

        elif tool_name == "pg_get_schema_info":
            args = PostgresSchemaArgs(**arguments)
            if args.connectionString:
                run_async(postgres_service.connect(args.connectionString))
                
            result = run_async(postgres_service.get_schema_info(args.tableName))
            message = (f"Информация о схеме таблицы {args.tableName}" if args.tableName 
                      else 'Список таблиц в базе данных')
                      
            return jsonify({
                "content": [
                    {
                        "type": "text",
                        "text": message
                    },
                    {
                        "type": "text",
                        "text": json.dumps(result, indent=2, ensure_ascii=False)
                    }
                ]
            })
            
        elif tool_name == "pg_get_sample_data":
            args = PostgresSampleDataArgs(**arguments)
            if args.connectionString:
                run_async(postgres_service.connect(args.connectionString))
                
            result = run_async(postgres_service.get_sample_data(args.tableName, args.limit, args.columns, workspace_id))
            return jsonify({
                "content": [{
                    "type": "text",
                    "text": f"Примеры {len(result)} строк из таблицы '{args.tableName}':\n{json.dumps(result, indent=2, ensure_ascii=False)}"
                }]
            })
            
        elif tool_name == "pg_analyze_relationships":
            if arguments.get('connectionString'):
                run_async(postgres_service.connect(arguments['connectionString']))
                
            result = run_async(postgres_service.analyze_relationships(
                arguments.get('includeImplicitRelations', False)
            ))
            return jsonify({
                "content": [
                    {
                        "type": "text",
                        "text": "Анализ взаимосвязей таблиц PostgreSQL:"
                    },
                    {
                        "type": "text", 
                        "text": json.dumps(result, indent=2, ensure_ascii=False)
                    }
                ]
            })
            
        else:
            return jsonify({"error": f"Unknown tool: {tool_name}"}), 400
            
    except Exception as e:
        print(f"ERROR in call_tool: {e}")
        return jsonify({"error": str(e)}), 500

# SSE endpoint for MCP protocol compatibility
@app.route('/sse', methods=['GET'])
def sse_endpoint():
    provided_key = request.args.get('authorization')
    
    if not provided_key or provided_key != access_key:
        return jsonify({'error': 'Unauthorized: invalid access key'}), 401
    
    def generate():
        session_id = str(uuid.uuid4())
        yield f"data: {json.dumps({'type': 'connection', 'sessionId': session_id})}\n\n"
        
        try:
            while True:
                time.sleep(1)
                yield "data: {}\n\n"  # Keep-alive ping
        except GeneratorExit:
            pass
    
    response = Response(generate(), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-cache'
    response.headers['Connection'] = 'keep-alive'
    response.headers['Access-Control-Allow-Origin'] = '*'
    
    return response

# Messages endpoint for MCP protocol compatibility
@app.route('/messages', methods=['POST'])
def messages_endpoint():
    return jsonify({'message': 'MCP messages endpoint - not fully implemented'}), 200

if __name__ == '__main__':
    try:
        # Initialize database connections
        run_async(init_connections())
        
        # Start the Flask server
        print('MCP MongoDB/PostgreSQL server running on port 3001')
        app.run(host='0.0.0.0', port=3001, debug=True)
        
    except KeyboardInterrupt:
        print("\n👋 Shutting down gracefully...")
    except Exception as e:
        print(f"❌ Application error: {e}")
        sys.exit(1)