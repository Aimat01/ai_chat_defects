import os
from dotenv import load_dotenv
import asyncio
import json
import urllib.parse
from typing import Dict, List, Any, Optional
import logging
from datetime import datetime
import socketio
from fastapi import FastAPI, HTTPException, Depends
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
import aiohttp
import random
import string
from contextlib import asynccontextmanager

# Import the authentication middleware (assuming it exists)
from auth_middleware import authorize

# Load environment variables
load_dotenv()

# Initialize FastAPI app
app = FastAPI()

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["authorization", "workspace", "Content-Type"],
)

# Configuration
PORT = int(os.getenv("PORT", 3000))
access_key = os.getenv("ACCESS_KEY")
server_url = os.getenv("SERVER_URL", "http://localhost:3001")

# OpenRouter API key
openrouter_api_key = os.getenv("OPENROUTER_API_KEY")

if not openrouter_api_key:
    print("Error: OpenRouter API key not found. Please add it to your .env file.")
    exit(1)

# Global variables
formatted_tools: List[Dict[str, Any]] = []
chat_sessions: Dict[str, List[Dict[str, Any]]] = {}
workspace_map: Dict[str, str] = {}

# System prompt in Russian
SYSTEM_PROMPT = """### **Роль и ограничения**
Вы — ассистент, анализирующий данные у которого есть доступ к данным 2025 года. Ваша задача — отвечать на вопросы пользователя, используя внутренние источники данных.

**СТРОГО ЗАПРЕЩЕНО:**
* Упоминать названия таблиц, коллекций, полей базы данных
* Говорить про SQL запросы, MongoDB запросы
* Упоминать технические термины (workspace_id, equipment_id, stat_date и т.д.)
* Просить уточнить названия полей или структуру данных

**ВАЖНО**: 
* Используйте историю разговора для понимания контекста
* Если пользователь ссылается на предыдущие результаты ("эти техники", "из списка выше"), используйте данные из предыдущих ответов
* При отсутствии данных продолжайте поиск, используя доступные инструменты (до 15 вызовов)
* НИКОГДА не спрашивайте про технические детали - просто выполняйте анализ

### **ВАЖНО: Агрегация и аналитика данных**
Для любых запросов на агрегацию, топ-списки, подсчеты используйте pg_execute_query с SQL

### **Источники данных**
* **MongoDB**: Информация о технике и документации.
    * equipments: Основной источник для получения equipment_id  содержит базовые данные по технике как (license_plate_number, passport_number) и тп.
    * equipment_history: Актуальные статусы (inspection_status: Пройдет, Не пройдет).
       * Алгоритм получения актуального статуса:
       - Отсортируйте по created_at (в формате строки) в порядке убывания.
       - Сгруппируйте по equipment_id.
       - Возьмите первую запись для каждой группы
    * defects: поломки, неисправности.
    * tickets: заявки на ремонт.
    * applications: заявки на обслуживание в СТО.
* **PostgreSQL**: Основные две таблицы.
    * daily_history_wfd: основная таблица где ты сможешь найти большинство данных. Всегда начинай с данной таблицы 
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
### **Инструменты для работы с данными:**
* **PostgreSQL**: pg_execute_query, pg_get_schema_info, pg_get_sample_data
* **MongoDB**: countDocuments, findDocuments, listCollections, getCollectionSchema, getSampleData
* findRelationshipsBetweenCollections для анализа связей
### **Важные правила выбора источника данных:**
* **Для подсчета количества техники**: используйте countDocuments с коллекцией "equipments"
* **Для поиска техники по номеру**: используйте findOneDocument с коллекцией "equipments" 
* **Для статистики работы техники**: используйте pg_execute_query с таблицей "daily_history_wfd"
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
7.  **Перед запросом**: Если ты получил данные после запроса получи схему таблиц/коллекции а также примеры данных определи где ты мог ошибиться и повтори запрос. Используй mongo-postgres-mcp-server"""


class MCPClient:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.server_url = config.get("server_url", server_url)
        self.access_key = config.get("access_key", access_key)
        self.connected = False

    async def connect(self):
        """Connect to real MCP server"""
        try:
            # Просто помечаем как подключенные без health check
            self.connected = True
            print(f"Connected to MCP server at {self.server_url}")
            
        except Exception as e:
            raise Exception(f"MCP connection error: {str(e)}")

    async def list_tools(self):
        """Get tools list from real MCP server"""
        if not self.connected:
            raise Exception("Not connected to MCP server")
        
        try:
            async with aiohttp.ClientSession() as session:
                tools_url = f"{self.server_url}/tools"
                headers = {"Authorization": f"Bearer {self.access_key}"}
                
                async with session.get(tools_url, headers=headers, timeout=30) as response:
                    if response.status == 200:
                        result = await response.json()
                        print(f"✅ Retrieved {len(result.get('tools', []))} tools from MCP server")
                        return result
                    else:
                        error_text = await response.text()
                        raise Exception(f"Failed to get tools: {response.status} - {error_text}")
        except Exception as e:
            print(f"❌ Error getting tools list: {e}")
            raise

    async def call_tool(self, tool_call: Dict[str, Any], workspace_id: str = None):
        """Call tool on real MCP server with workspace_id support"""
        if not self.connected:
            raise Exception("Not connected to MCP server")
        
        tool_name = tool_call.get("name")
        arguments = tool_call.get("arguments", {})
        
        # Добавляем workspace_id к аргументам если он передан
        if workspace_id and 'workspace_id' not in arguments:
            arguments['workspace_id'] = workspace_id
        
        try:
            async with aiohttp.ClientSession() as session:
                call_url = f"{self.server_url}/call-tool"
                headers = {
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {self.access_key}"
                }
                payload = {
                    "name": tool_name,
                    "arguments": arguments
                }
                
                async with session.post(call_url, json=payload, headers=headers, timeout=60) as response:
                    if response.status == 200:
                        result = await response.json()
                        return result
                    else:
                        error_text = await response.text()
                        return {
                            "content": [{
                                "type": "text",
                                "text": f"Tool execution failed: {response.status} - {error_text}"
                            }]
                        }
        except asyncio.TimeoutError:
            return {
                "content": [{
                    "type": "text", 
                    "text": f"Tool {tool_name} execution timeout"
                }]
            }
        except Exception as e:
            print(f"❌ Error calling tool {tool_name}: {e}")
            return {
                "content": [{
                    "type": "text",
                    "text": f"Tool execution error: {str(e)}"
                }]
            }

# Initialize MCP client
mcp_client = MCPClient({
    "name": "mongodb-gemini-chatbot", 
    "version": "1.0.0",
    "server_url": server_url,
    "access_key": access_key
})


async def ask_ai(session_id: str) -> Dict[str, Any]:
    """AI function with improved context handling"""
    try:
        messages = chat_sessions.get(session_id, [])
        
        if not messages:
            # Если истории нет, инициализируем с системным промптом
            messages = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "assistant", "content": "Понятно! Я готов помочь с анализом данных используя доступные инструменты."}
            ]
            chat_sessions[session_id] = messages

        # Очистка сообщений для OpenAI формата
        clean_messages = []
        for msg in messages:
            if msg.get("role") == "user":
                clean_messages.append({
                    "role": "user",
                    "content": msg.get("content", "")
                })
            elif msg.get("role") == "assistant":
                clean_msg = {
                    "role": "assistant", 
                    "content": msg.get("content")
                }
                
                if msg.get("tool_calls"):
                    clean_msg["tool_calls"] = msg["tool_calls"]
                    
                clean_messages.append(clean_msg)
            elif msg.get("role") == "tool":
                clean_messages.append({
                    "role": "tool",
                    "tool_call_id": msg.get("tool_call_id"),
                    "content": msg.get("content")
                })
            elif msg.get("role") == "system":
                clean_messages.append({
                    "role": "system",
                    "content": msg.get("content", "")
                })

        print(f"🔄 Session {session_id} - Sending {len(clean_messages)} messages to AI")
        
        # Показать последние несколько сообщений для отладки
        if len(clean_messages) > 2:
            print(f"📝 Last user message: {clean_messages[-1].get('content', '')[:100]}...")
            
        request_body = {
            "model": "google/gemini-2.5-flash",
            "messages": clean_messages,
            "temperature": 0.1,
            "max_tokens": 2048
        }

        if formatted_tools:
            request_body["tools"] = formatted_tools
            request_body["tool_choice"] = "auto"

        async with aiohttp.ClientSession() as session:
            async with session.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {openrouter_api_key}",
                    "HTTP-Referer": "http://localhost:3000", 
                    "X-Title": "MongoDB-Qwen-Chatbot"
                },
                json=request_body
            ) as response:
                if not response.ok:
                    error_data = await response.json()
                    raise Exception(f"API error: {response.status} - {json.dumps(error_data)}")

                response_data = await response.json()
                
                if not response_data or not response_data.get("choices"):
                    print("Invalid response structure:", response_data)
                    return {
                        "type": "error",
                        "text": "Получен некорректный ответ от API"
                    }

                assistant_message = response_data["choices"][0].get("message")

                if not assistant_message:
                    print("No message in response:", response_data["choices"][0])
                    return {
                        "type": "error",
                        "text": "Сообщение не найдено в ответе API"
                    }

                # Обработка вызовов инструментов
                if assistant_message.get("tool_calls"):
                    tool_call = assistant_message["tool_calls"][0]
                    print(f"🔧 Session {session_id} - Tool used:", tool_call["function"]["name"])

                    args = json.loads(tool_call["function"]["arguments"])
                    workspace_id = workspace_map.get(session_id)

                    tool_response = await mcp_client.call_tool({
                        "name": tool_call["function"]["name"],
                        "arguments": args
                    }, workspace_id)

                    tool_result = "No content received from tool"
                    if tool_response.get("content") and len(tool_response["content"]) > 0:
                        tool_result = tool_response["content"][0]["text"]

                    return {
                        "type": "tool_call",
                        "toolName": tool_call["function"]["name"],
                        "toolArgs": args,
                        "toolResult": tool_result,
                        "toolCallId": tool_call.get("id")
                    }
                elif assistant_message.get("content"):
                    return {
                        "type": "text",
                        "text": assistant_message["content"]
                    }
                    
                return {
                    "type": "text", 
                    "text": "Нет ответа от ИИ"
                }

    except Exception as error:
        print(f"❌ Error in askAI for session {session_id}:", error)
        return {
            "type": "error",
            "text": f"Произошла ошибка: {str(error)}"
        }


# Initialize Socket.IO server
sio = socketio.AsyncServer(
    cors_allowed_origins="*",
    cors_credentials=True,
    async_mode="asgi"
)

# Create Socket.IO ASGi app
socket_app = socketio.ASGIApp(sio, app)


@sio.event
async def clear_history(sid):
    """Clear chat history for session"""
    try:
        workspace = workspace_map.get(sid)
        if workspace:
            # Сброс до начального состояния
            initial_chat_history = [
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "assistant", "content": "История чата очищена. Чем могу помочь?"}
            ]
            chat_sessions[sid] = initial_chat_history
            await sio.emit('history_cleared', {'message': 'История чата успешно очищена'}, room=sid)
        else:
            await sio.emit('error', {'error': 'Session not found'}, room=sid)
    except Exception as error:
        await sio.emit('error', {'error': str(error)}, room=sid)


@sio.event
async def get_history_summary(sid):
    """Get summary of chat history"""
    try:
        messages = chat_sessions.get(sid, [])
        user_messages = [msg for msg in messages if msg.get("role") == "user"]
        assistant_messages = [msg for msg in messages if msg.get("role") == "assistant" and msg.get("content")]
        
        summary = {
            'total_messages': len(messages),
            'user_messages': len(user_messages),
            'assistant_messages': len(assistant_messages),
            'recent_topics': [msg.get("content", "")[:50] + "..." for msg in user_messages[-3:]]
        }
        
        await sio.emit('history_summary', summary, room=sid)
    except Exception as error:
        await sio.emit('error', {'error': str(error)}, room=sid)


@sio.event
async def connect(sid, environ, auth):
    """Handle socket connection with authentication"""
    try:
        # Extract headers from environ
        headers = {}
        for key, value in environ.items():
            if key.startswith('HTTP_'):
                header_name = key[5:].lower().replace('_', '-')
                headers[header_name] = value

        access_token = headers.get('authorization')
        workspace = headers.get('workspace')

        # Authorize the connection
        await authorize(access_token, workspace)
        workspace_map[sid] = workspace

        # Initialize chat session
        initial_chat_history = [
            {"role": "user", "content": SYSTEM_PROMPT},
            {"role": "assistant", "content": "Понятно! Я буду правильно использовать фильтры запросов для поиска связанных данных в MongoDB и собирать всю необходимую информацию для предоставления исчерпывающих ответов."}
        ]
        chat_sessions[sid] = initial_chat_history

        await sio.emit('session_created', {'sessionId': sid}, room=sid)
        print(f"Client {sid} connected from workspace {workspace}")

    except Exception as err:
        print('Данные сокета:', {
            'id': sid,
            'headers': headers if 'headers' in locals() else 'N/A'
        })
        await sio.disconnect(sid)
        raise Exception(f'Unauthorized: {str(err)}')


@sio.event
async def disconnect(sid):
    """Handle socket disconnection"""
    if sid in chat_sessions:
        del chat_sessions[sid]
    if sid in workspace_map:
        del workspace_map[sid]
    print(f"Client {sid} disconnected")


# Обработчик для любых событий
@sio.on('*')
async def catch_all(event, sid, data):
    print(f"Event: {event}, SID: {sid}, Data: {data}")

@sio.event
async def message(sid, message):
    """Handle chat message from client"""
    print(f"=== CHAT_MESSAGE HANDLER TRIGGERED ===")
    print(f"Received message from SID: {sid}")
    print(f"Message type: {type(message)}")
    print(f"Message content: {message}")
    
    try:
        if not message:
            await sio.emit('error', {'error': 'Message is required'}, room=sid)
            return

        workspace = workspace_map.get(sid, '')
        if not workspace:
            await sio.emit('error', {'error': 'Workspace ID is required'}, room=sid)
            return

        user_input = message.get('userMessage', '')
        print(f"User input: {user_input}")
        
        messages = chat_sessions.get(sid, [])
        
        # Добавляем сообщение пользователя
        messages.append({"role": "user", "content": user_input})
        
        # Управление размером истории - сохраняем последние 20 сообщений + системный промпт
        if len(messages) > 25:  # 2 системных + 23 обычных
            # Сохраняем системные сообщения (первые 2) и последние 20
            system_messages = messages[:2]  # Системный промпт и первый ответ
            recent_messages = messages[-20:]  # Последние 20 сообщений
            messages = system_messages + recent_messages
            chat_sessions[sid] = messages

        final_response = ''
        iteration_count = 0
        max_iterations = 15

        while iteration_count < max_iterations:
            iteration_count += 1
            
            # Передаем всю историю в AI
            ai_response = await ask_ai(sid)
            
            if ai_response["type"] == "error":
                final_response = ai_response["text"]
                break

            if ai_response["type"] == "text":
                final_response = ai_response["text"]
                # Добавляем ответ ассистента в историю
                messages.append({"role": "assistant", "content": ai_response["text"]})
                break

            if ai_response["type"] == "tool_call":
                await sio.emit('tool_call', {
                    'tool': ai_response["toolName"],
                    'args': ai_response["toolArgs"]
                }, room=sid)

                # Добавляем сообщение ассистента с вызовом инструмента
                tool_call_id = ai_response.get("toolCallId") or f"call_{''.join(random.choices(string.ascii_lowercase + string.digits, k=13))}"
                messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": tool_call_id,
                        "type": "function",
                        "function": {
                            "name": ai_response["toolName"],
                            "arguments": json.dumps(ai_response["toolArgs"])
                        }
                    }]
                })

                # Добавляем результат инструмента
                messages.append({
                    "role": "tool",
                    "tool_call_id": tool_call_id,
                    "content": json.dumps({"result": ai_response["toolResult"]})
                })

        if iteration_count >= max_iterations:
            final_response = "Извините, запрос слишком сложный. Попробуйте переформулировать его или уточнить детали."

        # Сохраняем обновленную историю
        chat_sessions[sid] = messages
        
        # Отправляем итоговый ответ
        await sio.emit('chat_response', {'response': final_response}, room=sid)

    except Exception as error:
        print('Error in chat message handler:', error)
        await sio.emit('error', {'error': 'Internal server error'}, room=sid)


async def setup_mcp_connection():
    """Setup MCP client connection and tools"""
    global formatted_tools
    
    try:
        # Подключение к MCP серверу
        await mcp_client.connect()
        print("✅ Connected to MCP server")
        
        # Получение списка инструментов
        tools_list = await mcp_client.list_tools()
        
        # Проверка что получили валидные инструменты
        if not tools_list or not tools_list.get("tools"):
            print("❌ No tools received from MCP server")
            formatted_tools = []
            return
        
        formatted_tools = []
        
        for tool in tools_list["tools"]:
            try:
                clean_properties = {}
                
                # Обработка properties инструмента
                for key, value in tool["inputSchema"].get("properties", {}).items():
                    clean_properties[key] = {
                        "description": value.get("description", ""),
                        "type": value.get("type", "string")
                    }
                    
                    # Вложенные properties
                    if value.get("properties"):
                        nested_properties = {}
                        for nested_key, nested_value in value["properties"].items():
                            nested_properties[nested_key] = {
                                "description": nested_value.get("description", ""),
                                "type": nested_value.get("type", "string")
                            }
                        clean_properties[key]["properties"] = nested_properties
                    
                    # Массивы
                    if value.get("items"):
                        clean_properties[key]["items"] = {
                            "type": value["items"].get("type", "string")
                        }
                
                # Формирование инструмента в формате OpenAI
                formatted_tool = {
                    "type": "function",
                    "function": {
                        "name": tool["name"],
                        "description": tool["description"],
                        "parameters": {
                            "type": tool["inputSchema"].get("type", "object"),
                            "properties": clean_properties,
                            "required": tool["inputSchema"].get("required", [])
                        }
                    }
                }
                
                formatted_tools.append(formatted_tool)
                
            except Exception as e:
                print(f"❌ Error processing tool {tool.get('name', 'unknown')}: {e}")
                continue
        
        print(f"✅ Loaded {len(formatted_tools)} tools:", [tool["function"]["name"] for tool in formatted_tools])
        
        # Проверка что инструменты загружены
        if not formatted_tools:
            print("⚠️  Warning: No tools were successfully loaded")
        
    except Exception as error:
        print(f"❌ Error setting up MCP connection: {error}")
        print(f"Server URL: {server_url}")
        print(f"Access key configured: {'Yes' if access_key else 'No'}")
        
        # В случае ошибки, попробуем использовать mock инструменты для тестирования
        print("🔧 Falling back to mock tools for testing...")
        formatted_tools = []
        raise


async def main():
    """Main application entry point"""
    try:
        # Настройка MCP подключения
        await setup_mcp_connection()
        
        # Запуск сервера
        config = uvicorn.Config(
            socket_app, 
            host="0.0.0.0", 
            port=PORT,
            log_level="info"
        )
        server = uvicorn.Server(config)
        print(f"🚀 HTTP server starting at http://0.0.0.0:{PORT}")
        await server.serve()
        
    except KeyboardInterrupt:
        print("\n👋 Shutting down gracefully...")
    except Exception as e:
        print(f"❌ Application error: {e}")
        raise

if __name__ == "__main__":
    asyncio.run(main())

# сколько у меня техник
# сколько дефектов у техники с номером 023WS02
# сколько дефектов у техники с номером 320AU07
# которая из моих техник ломается чаще всего
# какая модель у техники с номером 023WS02
# какой бренд у техники с номером 023WS02
# подскажи пожалуйста какие техники был простое за сентябрь 2025 год
# можешь дать какие из этих техник больше всего в простое дай топ 10