import os
from motor.motor_asyncio import AsyncIOMotorClient
from dotenv import load_dotenv

load_dotenv()

mongo_url = os.environ.get('MONGODB_URI')
db_name = os.environ.get('MONGODB_NAME')

client = AsyncIOMotorClient(mongo_url)
db = client[db_name]

async def authorize(access_token, workspace_id, is_global_scope=False):
    if not access_token:
        raise Exception('Authorization header not found')
    if not workspace_id and not is_global_scope:
        raise Exception('Workspace header not found')
    
    try:
        session = await db.sessions.find_one({'_id': access_token})

        if not session:
            raise Exception('Session not found')

    except Exception as e:
        raise Exception('DB error')


    if not session['user']['is_activated']:
        raise Exception('User is not activated')
    
    if session['user']['state'] == 'ARCHIVED':
        raise Exception('User is archived')

