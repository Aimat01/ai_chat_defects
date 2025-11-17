import sys
import os
import time
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

from auth_middleware import authorize

load_dotenv()

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["authorization", "workspace", "Content-Type"],
)

PORT = int(os.getenv("PORT", 3002))
access_key = os.getenv("ACCESS_KEY")
server_url = os.getenv("SERVER_URL", "http://host.docker.internal:3003")

openrouter_api_key = os.getenv("OPENROUTER_API_KEY")

if not openrouter_api_key:
    print("Error: OpenRouter API key didn't found. Please check your .env file")
    exit(1)

formatted_tools: List[Dict[str, Any]] = []
chat_sessions: Dict[str, List[Dict[str, any]]] = {}
workspace_map: Dict[str, str] = {}



DEFECT_AI_SYSTEM_PROMPT = """### **DefectAI - Анализ дефектов техники**

Вы - специализированный ассистент для анализа дефектов техники и автозаполнения форм дефектов.

**ВАЖНО**: Всегда возвращайте ответы в чистом JSON формате БЕЗ markdown (без ```json).

**ЭТАП 1 - Анализ дефекта (stage: "analysis"):**
Пользователь вводит:
- Техника: марка, модель, тип/класс (легковая, автобус, грузовая), гос номер, VID
- Название дефекта: краткое описание проблемы (например: "машина не заводиться", "перегрев двигателя")

Алгоритм:
1. **ОБЯЗАТЕЛЬНО** используйте для поиска возможных причин
2. Поисковые запросы:
    -"{марка} {модель} {название_дефекта} причины неисправности"
    -"{марка} {модель} {название_дефекта} типичные поломки"
3. Проанализируйте результаты поиска
4. Верните JSON с 3-5 набиолее вероятными причинами

**ЭТАП 2 - Детальный анализ (stage: "details"):**
Пользователь выбрал одну из причин

Алгоритм:
1. **ПЕРВЫМ ДЕЛОМ** вызовите get_vehicle_data с license_plate для получения актуальных данных
2. Используйте web_search для поиска деталей:
    -"{причина} {марка} {модель} запчасти артикулы" 
    -"{причина} ремонт работы регламент"
    -"{причина} {марка} {модель} инструкция замены"
3. Определите категорию поломки из списка:
   - "Гидравлические поломки"
   - "Электрические поломки"  
   - "Системы охлаждения"
   - "Топливные поломки"
   - "Пневматические поломки"
   - "Механические поломки"
   - "Гидравлическая система стрелы"
   - "Системы кондиционирования и отопления"
   - "Программные и сенсорные поломки"
   - "Коррозия и износ кузова"
4. Объедините все данные в финальный JSON ответ

**Формат ответа ЭТАП 1:**
{
    "stage": "analysis",
    "vehicle": {
        "brand": "Toyota",
        "model": "Land Cruiser Prado", 
        "type": "легковая",
        "license_plate": "ABC123"
    },
    "defect_description": "не заводится",
    "possible_causes": [
        "Разряжен аккумулятор",
        "Неисправен стартер или реле стартера", 
        "Проблемы с системой зажигания (свечи, катушки)",
        "Закончилось топливо или неисправен топливный насос",
        "Неисправность иммобилайзера"
    ]
}

**Формат ответа ЭТАП 2:**
{
    "stage": "details",
    "selected_cause": "Разряжен аккумулятор",
    "category": "Электрические поломки",
    "description": "Аккумуляторная батарея не способна обеспечить достаточный пусковой ток для запуска двигателя. Это может быть вызвано естественным износом, глубоким разрядом, неисправностью генератора или утечкой тока в системе.",
    "spare_parts": [
        {"name": "Аккумулятор 12V 100Ah", "quantity": 1, "article": "FB9-A"},
        {"name": "Клеммы аккумуляторные", "quantity": 2, "article": "T-2515"}
    ],
    "works": [
        "Диагностика электросистемы - 0.5ч",
        "Демонтаж старого аккумулятора - 0.3ч",
        "Установка нового аккумулятора - 0.3ч",
        "Проверка системы зарядки - 0.4ч"
    ],
    "auto_data": {
        "mileage": 125000,
        "engine_hours": 3200,
        "managers": ["Иванов И.И."],
        "project": "Проект А"
    },
    "analytics_url": "https://streamlit.equipmetry.kz/vehicle_rating?plate=ABC123"
}

**КРИТИЧНО**: 
- В этапе 2 ВСЕГДА вызывайте get_vehicle_data перед формированием ответа
- Используйте реальные данные из get_vehicle_data для заполнения auto_data
- НЕ возвращайте null если данные получены успешно
- Всегда включайте ссылку на аналитику с правильным номером техники
- Категория должна быть выбрана из списка выше (точное совпадение)
- Возвращайте ТОЛЬКО JSON без markdown форматирования
"""

class MCPClient:
    def __init__(self, config: Dict[str, Any]):
        self.config = config
        self.server_url = config.get("server_url", server_url)
        self.access_key = config.get("access_key", access_key)
        self.connected = False
        


    async def connect(self):
        """Connect to real MCP server"""
        try:
            if(self.server_url is not None and self.access_key is not None):
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
            messages = [
                {"role": "system", "content": DEFECT_AI_SYSTEM_PROMPT},
                {"role": "assistant", "content": "Понятно! Я готов помочь с анализом данных используя доступные инструменты."}
            ]
            chat_sessions[session_id] = messages

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
        print(f"Количество сообщений: {len(clean_messages)}")

        if len(clean_messages) > 2:
            print(f"📝 Last user message: {clean_messages[-1].get('content', '')}")

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
                    "HTTP-Referer": "http://localhost:3002", 
                    "X-Title": "MongoDB-Qwen-Chatbot"
                },
                json=request_body
            ) as response:
                if not response.ok:
                    error_data = await response.json()
                    raise Exception(f"API error: {response.status} - {json.dumps(error_data)}")

                response_data = await response.json()

                print(f"AI answer: (session{session_id})")
                print(f"Response keys: {response_data.keys()}")
                print(f"Choices: {len(response_data.get('choices', []))}")

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
                
                if assistant_message.get("tool_calls"):
                    tool_call = assistant_message["tool_calls"][0]
                    
                    print(f"🔧 Session {session_id} - Tool used:", tool_call["function"]["name"])

                    args = json.loads(tool_call["function"]["arguments"])
                    workspace_id = workspace_map.get(session_id)
                    
                    tool_response = await mcp_client.call_tool({
                        "name": tool_call["function"]["name"],
                        "arguments": args
                    }, workspace_id)

                    print(f"Tool results: {tool_call['function']['name']}")

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
    


sio = socketio.AsyncServer(
    cors_allowed_origins="*",
    cors_credentials=True,
    async_mode="asgi"
)

socket_app = socketio.ASGIApp(sio, app)



@sio.event
async def clear_history(sid):
    """Clear chat history for session"""
    try:
        workspace = workspace_map.get(sid)
        if workspace:
            initial_chat_history = [
                {"role": "system", "content": DEFECT_AI_SYSTEM_PROMPT},
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
            'recent_topics': [msg.get("content", "") + "..." for msg in user_messages[-3:]]
        }

        await sio.emit('history_summary', summary, room=sid)
    except Exception as e:
        await sio.emit('error', {'error': str(e)}, room=sid)



@sio.event
async def connect(sid, environ, auth):
    """Handle socket connection with authentication"""
    try:
        headers = {}
        for key, value in environ.items():
            if key.startswith('HTTP_'):
                header_name = key[5:].lower().replace('_', '-')
                headers[header_name] = value

        print(f"Auth данные: {auth}")

        # access_token = headers.get('authorization')
        workspace = headers.get('workspace')

        print(f"🔑 Authorization: {access_token}")
        print(f"🏢 Workspace: {workspace}")

        # await authorize(access_token, workspace)

        workspace_map[sid] = workspace

        initial_chat_history = [
            {"role": "system", "content": DEFECT_AI_SYSTEM_PROMPT},
            {"role": "assistant", "content": "DefectAI готов к анализу дефектов техники!"}
        ]
        chat_sessions[sid] = initial_chat_history

        await sio.emit('session_created', {'sessionId': sid}, room=sid)
        print(f"✅ Client {sid} connected from workspace {workspace}") 

    except Exception as err:
        print(f"❌ Connection error for {sid}: {str(err)}")
        
        await sio.emit('error', {'message': f'Unauthorized: {str(err)}'}, room=sid)
        
        await sio.disconnect(sid)



@sio.event
async def disconnect(sid):
    """Handle socket disconnection"""
    if sid in chat_sessions:
        del chat_sessions[sid]
    if sid in workspace_map:
        del workspace_map[sid]
    print(f"Client {sid} disconnected")



@sio.on('*')
async def catch_all(event, sid, data):
    """Catch all events for debugging"""
    print(f"Event: {event}, SID: {sid}, Data: {data}")



@sio.event
async def message(sid, message):
    """Handle defect analysis requests"""
    print(f"=== DEFECT ANALYSIS REQUEST ===")
    print(f"SID: {sid}, Message type: {type(message)}")
    print(f"Message content: {message}")

    try:
        if isinstance(message, str):
            try:
                message = json.loads(message)
            except json.JSONDecodeError:
                await sio.emit('error', {'error': 'Invalid JSON'}, room=sid)
                return
            
        if not message:
            await sio.emit('error', {'error': 'Message is required'}, room=sid)
            return
        
        workspace = workspace_map.get(sid, "")
        if not workspace:
            await sio.emit('error', {'error': 'Workspace ID is required'}, room=sid)
            return
        
        stage = message.get('stage')
        
        if stage == 'analysis':
            await handle_defect_analysis(sid, message, workspace)
        elif stage == 'details':
            await handle_cause_details(sid, message, workspace)
        else:
            user_message = message.get('userMessage', message.get('defect_description', ''))
            if user_message:
                await handle_regular_chat(sid, {'userMessage': user_message}, workspace)
            else:
                await sio.emit('error', {'error': 'Unknown message format'}, room=sid)
    
    except Exception as error:
        print(f'Error in message handler: {error}')
        import traceback
        traceback.print_exc()
        await sio.emit('error', {'error': f'Analysis failed: {str(error)}'}, room=sid)
        


async def handle_defect_analysis(sid, message, workspace):
    """Этап 1: Анализ дефекта и поиск причин через web_search"""
    vehicle_info = message.get('vehicle', {})
    defect_description = message.get('defect_description', '')

    brand = vehicle_info.get('brand', '')
    model = vehicle_info.get('model', '')
    vehicle_type = vehicle_info.get('type', '')
    license_plate = vehicle_info.get('license_plate', '')
    

    print(f"🔍 Анализируем дефект: {defect_description}")
    print(f"🚗 Техника: {brand} {model} ({vehicle_type}) - {license_plate}")

    await emit_debug_event(sid, 'reasoning', {
        'stage': 'analysis',
        'message': f'Начинаем анализ дефекта: {defect_description}',
        'timestamp': time.time()
    })

    analysis_prompt = f"""Проанализируй дефект техники и найди возможные причины используя web_search:
    
Техника: {brand} {model} (тип: {vehicle_type})
Гос номер: {license_plate}
Название дефекта: {defect_description}

ВАЖНО: 
1. Используй web_search с запросом: "{brand} {model} {defect_description} причины неисправности"
2. Верни результат СТРОГО в JSON формате:
{{
    "stage": "analysis",
    "vehicle": {{
        "brand": "{brand}",
        "model": "{model}",
        "type": "{vehicle_type}",
        "license_plate": "{license_plate}"
    }},
    "defect_description": "{defect_description}",
    "possible_causes": [
        "Причина 1",
        "Причина 2",
        "Причина 3"
    ]
}}

Найди 3-5 наиболее вероятных причин данного дефекта через web_search."""
    
    messages = chat_sessions.get(sid, [])
    messages.append({"role": "user", "content": analysis_prompt})
    chat_sessions[sid] = messages
    
    final_response = await process_ai_request_with_debug(sid)

    await emit_debug_event(sid, 'reasoning', {
        'stage': 'analysis',
        'message': 'Анализ завершен',
        'timestamp': time.time()
    })    

    print(f"📤 Отправляем результат анализа: {final_response}...")
    await sio.emit('defect_analysis_result', {'response': final_response}, room=sid)



async def handle_cause_details(sid, message, workspace):
    """Этап 2: Детальная информация по выбраннной причине"""
    vehicle_info = message.get('vehicle', {})
    selected_cause = message.get('selected_cause', [])
    
    brand = vehicle_info.get('brand', '')
    model = vehicle_info.get('model', '')
    vehicle_type = vehicle_info.get('type', '')
    license_plate = vehicle_info.get('license_plate', '')

    causes_text = '\n'.join([f"- {cause}" for cause in selected_cause])

    print(f"🔍 Получаем детали для причины: {causes_text}")

    await emit_debug_event(sid, 'reasoning', {
        'stage': 'details',
        'message': f'Собираем детальную информацию по причине: {selected_cause}',
        'timestamp': time.time()
    })

    details_prompt = f"""Получи детальную информацию по выбранной причине дефекта:

Техника: {brand} {model} (тип: {vehicle_type})
Гос номер: {license_plate}

Выбранные причини: {causes_text}

ОБЯЗАТЕЛЬНЫЕ шаги:
1. Используй web_search для поиска подробной информации о каждой причине
2. Поиск запчастей: объедини все необходимые запчасти для всех причин
3. Поиск работ: объедини все необходимые работы для всех причин
4. ОБЯЗАТЕЛЬНО вызови get_vehicle_data с license_plate="{license_plate}"

КРИТИЧНО - выбери категорию ТОЧНО из этого списка:
   - "Гидравлические поломки"
   - "Электрические поломки"  
   - "Системы охлаждения"
   - "Топливные поломки"
   - "Пневматические поломки"
   - "Механические поломки"
   - "Гидравлическая система стрелы"
   - "Системы кондиционирования и отопления"
   - "Программные и сенсорные поломки"
   - "Коррозия и износ кузова"

Верни результат в JSON формате:
{{
    "stage": "details",
    "selected_cause": "{selected_cause}",
    "category": "Точное название из списка выше",
    "description": "Подробное описание причины и её влияния",
    "spare_parts": [
        {{"name": "Название запчасти", "quantity": 1, "article": "Артикул"}}
    ],
    "works": [
        "Название работы 1 - время в часах",
        "Название работы 2 - время в часах"
    ],
    "auto_data": {{
        "mileage": "из get_vehicle_data",
        "engine_hours": "из get_vehicle_data",
        "managers": "из get_vehicle_data",
        "project": "из get_vehicle_data"
    }},
    "analytics_url": "https://streamlit.equipmetry.kz/vehicle_rating?plate={license_plate}"
}}
"""
    
    messages = chat_sessions.get(sid, [])
    messages.append({"role": "user", "content": details_prompt})
    chat_sessions[sid] = messages

    final_response = await process_ai_request_with_debug(sid)

    await emit_debug_event(sid, 'reasoning', {
        'stage': 'details',
        'message': 'Сбор деталей завершен',
        'timestamp': time.time()
    })
    
    print(f"📤 Отправляем детали: {final_response}...")
    await sio.emit('defect_details_result', {'response': final_response}, room=sid)



async def handle_regular_chat(sid, message, workspace):
    """Обработка обычного чата (для совместимости)"""
    user_message =  message.get('userMessage', '')

    if not user_message:
        await sio.emit('error', {'error': 'User message is required'}, room=sid)
        return
    
    messages = chat_sessions.get(sid, [])
    messages.append({"role": "user", "content": user_message})
    chat_sessions[sid] = messages
    
    final_response = await process_ai_request(sid)
    
    await sio.emit('chat_response', {'response': final_response}, room=sid)
    


async def emit_debug_event(sid, event_type, data):
    """Отправить событие отладки клиенту
    event_type: 'tool_call', 'search', 'database', 'reasoning'
    """
    await sio.emit(f'ai_{event_type}', data, room=sid)



async def process_ai_request(sid):
    """Общая логика обработки AI запроса БЕЗ отладки"""
    final_response = ''
    iteration_count = 0
    max_iterations = 15
    messages = chat_sessions.get(sid, [])

    while iteration_count < max_iterations:
        iteration_count += 1
        ai_response = await ask_ai(sid)

        if ai_response["type"] == "error":
            final_response = ai_response["text"]
            break

        if ai_response["type"] == "text":
            final_response = ai_response["text"]
            messages.append({"role": "assistant", "content": ai_response["text"]})
            break
        
        if ai_response["type"] == "tool_call":
            tool_call_id = ai_response.get("tollCallId") or f"call_{''.join(random.choices(string.ascii_lowercase + string.digits, k=13))}"

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

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": json.dumps({"result": ai_response["toolResult"]})
            })
            
    if iteration_count >= max_iterations:
        final_response = "Извините, запрос слишком сложный. Попробуйте переформулировать."

    chat_sessions[sid] = messages
    return final_response



async def process_ai_request_with_debug(sid):
    """Улучшенная версия process_ai_request с отладочными событиями"""
    final_response = ''
    iteration_count = 0
    max_iterations = 15
    messages = chat_sessions.get(sid, [])

    while iteration_count < max_iterations:
        iteration_count += 1
        
        await emit_debug_event(sid, 'reasoning', {
            'iteration': iteration_count,
            'message': f'Итерация {iteration_count}/{max_iterations}'
        })

        ai_response = await ask_ai(sid)

        if ai_response["type"] == "error":
            final_response = ai_response["text"]
            break

        if ai_response["type"] == "text":
            final_response = ai_response["text"]
            messages.append({"role": "assistant", "content": ai_response["text"]})
            break

        if ai_response["type"] == "tool_call":
            tool_name = ai_response["toolName"]
            tool_args = ai_response["toolArgs"]

            await emit_debug_event(sid, 'tool_call', {
                'name': tool_name,
                'arguments': tool_args,
                'status': 'calling',
                'timestamp': time.time()
            })

            if tool_name == 'web_search':
                query = tool_args.get('query', '')

                await emit_debug_event(sid, 'search', {
                    'query': query,
                    'status': 'searching',
                    'timestamp': time.time()
                })

                try:

                    tool_result = ai_response["toolResult"]

                    await emit_debug_event(sid, 'search', {
                        'query': query,
                        'resultsCount': 5,
                        'summary': ai_response["toolResult"] if isinstance(ai_response["toolResult"], str) else "OK",
                        'fullResults': tool_result,
                        'status': 'completed',
                        'timestamp': time.time()
                    })

                except Exception as e:
                    await emit_debug_event(sid, 'search', {
                        'query': query,
                        'status': 'error',
                        'error': str(e),
                        'timestamp': time.time()
                    })

            elif tool_name == 'get_vehicle_data':
                license_plate = tool_args.get('license_plate', '')

                await emit_debug_event(sid, 'database', {
                    'operation': 'get_vehicle_data',
                    'table': 'daily_history_wfd',
                    'query': f"license_plate = '{license_plate}'",
                    'status': 'executing',
                    'timestamp': time.time()
                })

                try:
                    result_data = ai_response.get("toolResult", {})

                    if isinstance(result_data, str):
                        try:
                            result_data = json.loads(result_data)
                        except:
                            pass

                    records_found = 1 if "found" in str(result_data) else 0

                    await emit_debug_event(sid, 'database', {
                        'operation': 'get_vehicle_data',
                        'table': 'daily_history_wfd',
                        'recordsFound': records_found,
                        'fullData': result_data,
                        'status': 'completed',
                        'timestamp': time.time()
                    })
                
                except Exception as e:
                    await emit_debug_event(sid, 'database', {
                        'operation': 'get_vehicle_data',
                        'status': 'error',
                        'error': str(e),
                        'timestamp': time.time()
                    })
            
            elif tool_name in ['findDocuments', 'countDocuments', 'pg_execute_query']:
                operation = tool_name
                collection = tool_args.get('collection') or tool_args.get('table', 'unknown')

                await emit_debug_event(sid, 'database', {
                    'operation': operation,
                    'collection': collection,
                    'query': str(tool_args.get('query', {})),
                    'status': 'executing',
                    'timestamp': time.time()
                })

                await emit_debug_event(sid, 'database', {
                    'operation': operation,
                    'collection': collection,
                    'status': 'completed',
                    'timestamp': time.time()
                })

            tool_call_id = ai_response.get("toolCallId") or f"call_{''.join(random.choices(string.ascii_lowercase + string.digits, k=13))}"

            messages.append({
                "role": "assistant",
                "content": None,
                "tool_calls": [{
                    "id": tool_call_id,
                    "type": "function",
                    "function": {
                        "name": tool_name,
                        "arguments": json.dumps(tool_args)
                    }
                }]
            })

            messages.append({
                "role": "tool",
                "tool_call_id": tool_call_id,
                "content": json.dumps({"result": ai_response["toolResult"]})
            })

            await emit_debug_event(sid, 'tool_call', {
                'name': tool_name,
                'arguments': tool_args,
                'result': str(ai_response["toolResult"]) if isinstance(ai_response["toolResult"], str) else 'OK',
                'status': 'success',
                'timestamp': time.time()
            })

    if iteration_count >= max_iterations:
        final_response = "Извините, запрос слишком сложный. Попробуйте переформулировать."

    chat_sessions[sid] = messages
    return final_response

async def setup_mcp_connection():
    """Setup MCP client connection and tools"""
    global formatted_tools

    try:
        await mcp_client.connect()
        print("✅ Connected to MCP server")

        tools_list = await mcp_client.list_tools()

        if not tools_list or not tools_list.get("tools"):
            print("❌ No tools received from MCP server")
            formatted_tools = []
            return
        
        formatted_tools = []

        for tool in tools_list["tools"]:
            try:
                clean_properties = {}

                for key, value in tool["inputSchema"].get("properties", {}).items():
                    clean_properties[key] = {
                        "description": value.get("description", ""),
                        "type": value.get("type", "string")
                    }

                    if value.get("properties"):
                        nested_properties = {}
                        for nested_key, nested_value in value["properties"].items():
                            nested_properties[nested_key] = {
                                "description": nested_value.get("description", ""),
                                "type": nested_value.get("type", "string")
                            }

                        clean_properties[key]["properties"] = nested_properties

                    if value.get("items"):
                        clean_properties[key]["items"] = {
                            "type": value["items"].get("type", "string")
                        }

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

        if not formatted_tools:
            print("⚠️  Warning: No tools were successfully loaded")

    except Exception as error:
        print(f"❌ Error setting up MCP connection: {error}")
        print(f"Server URL: {server_url}")
        print(f"Access key configured: {'Yes' if access_key else 'No'}")
        formatted_tools = []
        raise

async def main():
    """Main application entry point"""
    try:
        await setup_mcp_connection()

        config = uvicorn.Config(
            socket_app,
            host = "0.0.0.0",
            port = PORT,
            log_level = "info"
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