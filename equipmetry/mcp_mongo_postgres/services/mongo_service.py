import os
from motor.motor_asyncio import AsyncIOMotorClient
from bson import ObjectId, json_util
from dotenv import load_dotenv
import re
from typing import Dict, List, Any, Optional, Union
import copy
import json

load_dotenv()

def getSimplifiedSchema(documents: List[Dict]) -> Dict:
    """
    Python equivalent of mongodb-schema's getSimplifiedSchema function
    """
    if not documents:
        return {}
    
    schema = {}
    total_docs = len(documents)
    
    for document in documents:
        for field, value in document.items():
            if field not in schema:
                schema[field] = {
                    'types': set(),
                    'count': 0
                }
            
            schema[field]['count'] += 1
            
            if value is None:
                schema[field]['types'].add('null')
            elif isinstance(value, bool):
                schema[field]['types'].add('boolean')
            elif isinstance(value, int):
                schema[field]['types'].add('number')
            elif isinstance(value, float):
                schema[field]['types'].add('number')
            elif isinstance(value, str):
                schema[field]['types'].add('string')
            elif isinstance(value, list):
                schema[field]['types'].add('array')
            elif isinstance(value, dict):
                schema[field]['types'].add('object')
            elif isinstance(value, ObjectId):
                schema[field]['types'].add('objectId')
            else:
                schema[field]['types'].add(type(value).__name__)
    
    # Convert sets to lists and add frequency information
    for field in schema:
        schema[field]['types'] = list(schema[field]['types'])
        schema[field]['frequency'] = round((schema[field]['count'] / total_docs) * 100)
    
    return schema


class MongoDBService:
    def __init__(self, uri=None, dbName=None):
        if uri is None:
            uri = os.environ.get('MONGODB_URI')
        if dbName is None:
            dbName = os.environ.get('MONGODB_NAME')
            
        if not uri:
            raise Exception('MongoDB URI is not defined')
        if not dbName:
            raise Exception('Database name is not defined')
            
        self.client = AsyncIOMotorClient(uri)
        self.dbName = dbName
        self.db = None

    def add_workspace_filter(self, query, workspace_id=None):
        """Добавляет фильтр по workspace_id к запросу если он передан"""
        if not workspace_id:
            return query
            
        # Создаем копию запроса
        filtered_query = copy.deepcopy(query) if query else {}
        
        # Добавляем фильтр по workspace_id
        if isinstance(workspace_id, str):
            try:
                workspace_id = ObjectId(workspace_id)
            except:
                pass  # Если не ObjectId, оставляем как есть
                
        filtered_query['workspace_id'] = workspace_id
        return filtered_query

    async def connect(self):
        try:
            self.db = self.client[self.dbName]
            print('Connected to MongoDB')
            return self.db
        except Exception as error:
            print('MongoDB connection error:', error)
            raise error

    async def disconnect(self):
        try:
            self.client.close()
            print('Disconnected from MongoDB')
        except Exception as error:
            print('MongoDB disconnection error:', error)
            raise error

    # Find documents
    async def find(self, collectionName, query=None, options=None, workspace_id=None):
        if query is None:
            query = {}
        if options is None:
            options = {}
            
        try:
            collection = self.db[collectionName]
            
            # Добавляем фильтр по workspace_id
            query = self.add_workspace_filter(query, workspace_id)
            
            # Process query to handle ObjectId if needed
            query = self.processObjectIds(query)

            limit = options.get('limit', 0)
            skip = options.get('skip', 0)
            sort = options.get('sort', {})
            projection = options.get('projection', {})
            
            cursor = collection.find(query)
            
            if sort:
                # Convert sort dict to list of tuples for pymongo
                sort_list = [(k, v) for k, v in sort.items()]
                cursor = cursor.sort(sort_list)
            if skip > 0:
                cursor = cursor.skip(skip)
            if limit > 0:
                cursor = cursor.limit(limit)
            if projection:
                cursor = cursor.projection(projection)
                
            result = await cursor.to_list(length=None)
            
            # Convert ObjectId to JSON serializable format using bson.json_util
            return json.loads(json_util.dumps(result))
            
        except Exception as error:
            print(f'Error finding documents in {collectionName}:', error)
            raise error

    # Find one document
    async def findOne(self, collectionName, query=None, options=None, workspace_id=None):
        if query is None:
            query = {}
        if options is None:
            options = {}
            
        try:
            collection = self.db[collectionName]
            
            # Добавляем фильтр по workspace_id
            query = self.add_workspace_filter(query, workspace_id)
            
            query = self.processObjectIds(query)
            projection = options.get('projection', {})
            
            if projection:
                result = await collection.find_one(query, projection)
            else:
                result = await collection.find_one(query)
                
            # Convert ObjectId to JSON serializable format using bson.json_util
            if result:
                return json.loads(json_util.dumps(result))
                
            return result
        except Exception as error:
            print(f'Error finding document in {collectionName}:', error)
            raise error
        
    # Run aggregation pipeline
    async def aggregate(self, collectionName, pipeline, options=None, workspace_id=None):
        if options is None:
            options = {}
            
        try:
            collection = self.db[collectionName]
            # Process pipeline stages that might contain ObjectId references
            pipeline = copy.deepcopy(pipeline)
            pipeline = self.processObjectIdsInPipeline(pipeline)

            # Добавляем фильтр по workspace_id в начало pipeline
            if workspace_id:
                workspace_filter = {'workspace_id': workspace_id}
                if isinstance(workspace_id, str):
                    try:
                        workspace_filter['workspace_id'] = ObjectId(workspace_id)
                    except:
                        pass
                
                # Добавляем $match в начало pipeline если его там нет
                if not pipeline or not any('$match' in stage for stage in pipeline[:1]):
                    pipeline.insert(0, {'$match': workspace_filter})
                else:
                    # Добавляем workspace_id к существующему $match
                    for stage in pipeline:
                        if '$match' in stage:
                            stage['$match'].update(workspace_filter)
                            break

            cursor = collection.aggregate(pipeline, **options)
            result = await cursor.to_list(length=None)
            
            # Convert ObjectId to JSON serializable format using bson.json_util
            return json.loads(json_util.dumps(result))
            
        except Exception as error:
            print(f'Error running aggregation on {collectionName}:', error)
            raise error

    # Count documents
    async def countDocuments(self, collectionName, query=None, options=None, workspace_id=None):
        if query is None:
            query = {}
        if options is None:
            options = {}
             
        try:
            collection = self.db[collectionName]
            
            # Добавляем фильтр по workspace_id
            query = self.add_workspace_filter(query, workspace_id)
            
            query = self.processObjectIds(query)
            return await collection.count_documents(query, **options)
        except Exception as error:
            print(f'Error counting documents in {collectionName}:', error)
            raise error

    # List collections
    async def listCollections(self):
        try:
            collections_cursor = self.db.list_collections()
            collections = await collections_cursor.to_list(length=None)
            return [collection['name'] for collection in collections]
        except Exception as error:
            print('Error listing collections:', error)
            raise error

    # Get collection schema recursively with nested objects
    async def getCollectionSchema(self, collectionName, sampleSize=5, includeNestedObjects=True, workspace_id=None):
        try:
            collection = self.db[collectionName]
            
            # Создаем фильтр для выборки по workspace_id
            filter_query = {}
            if workspace_id:
                filter_query = self.add_workspace_filter({}, workspace_id)
                
            cursor = collection.find(filter_query).limit(sampleSize)
            documents = await cursor.to_list(length=sampleSize)

            if len(documents) == 0:
                raise Exception(f'Collection "{collectionName}" is empty or doesn\'t exist for this workspace')

            baseSchema = getSimplifiedSchema(documents)

            enhancedSchema = baseSchema

            if includeNestedObjects:
                enhancedSchema = self.enhanceSchemaWithNestedObjects(baseSchema, documents)

            return {
                'collectionName': collectionName,
                'documentCount': len(documents),
                'sampleSize': sampleSize,
                'schema': enhancedSchema,
                'nestedObjectsAnalyzed': includeNestedObjects
            }
        except Exception as error:
            print(f'Error getting schema for {collectionName}:', error)
            raise error

    def enhanceSchemaWithNestedObjects(self, baseSchema, documents, maxDepth=3):
        enhanced = copy.deepcopy(baseSchema)

        for field in baseSchema.keys():
            fieldInfo = baseSchema[field]

            if fieldInfo.get('types') and 'object' in fieldInfo['types']:
                objectSamples = []
                for doc in documents:
                    value = doc.get(field)
                    if isinstance(value, dict) and value is not None and not isinstance(value, list):
                        objectSamples.append(value)

                if len(objectSamples) > 0:
                    enhanced[field] = {
                        **fieldInfo,
                        'objectStructure': self.analyzeObjectStructureRecursive(objectSamples, maxDepth, 0)
                    }

            if fieldInfo.get('types') and 'array' in fieldInfo['types']:
                arraySamples = []
                for doc in documents:
                    value = doc.get(field)
                    if isinstance(value, list):
                        arraySamples.append(value)

                if len(arraySamples) > 0:
                    arrayElements = []
                    for arr in arraySamples:
                        arrayElements.extend(arr)
                    
                    objectElements = [el for el in arrayElements 
                                     if isinstance(el, dict) and el is not None and not isinstance(el, list)]

                    if len(objectElements) > 0:
                        enhanced[field] = {
                            **fieldInfo,
                            'arrayElementStructure': self.analyzeObjectStructureRecursive(objectElements, maxDepth, 0)
                        }

        return enhanced

    def analyzeObjectStructureRecursive(self, objects, maxDepth=3, currentDepth=0):
        fieldCounts = {}
        fieldTypes = {}
        nestedObjects = {}

        for obj in objects:
            for key in obj.keys():
                fieldCounts[key] = fieldCounts.get(key, 0) + 1

                if key not in fieldTypes:
                    fieldTypes[key] = set()

                value = obj[key]
                if value is None:
                    fieldTypes[key].add('null')
                elif isinstance(value, ObjectId):
                    fieldTypes[key].add('objectId')
                elif isinstance(value, list):
                    fieldTypes[key].add('array')

                    if currentDepth < maxDepth:
                        objectElements = [el for el in value 
                                         if isinstance(el, dict) and el is not None and not isinstance(el, list)]
                        if len(objectElements) > 0:
                            if key not in nestedObjects:
                                nestedObjects[key] = {'type': 'array', 'elements': []}
                            nestedObjects[key]['elements'].extend(objectElements)
                elif isinstance(value, dict):
                    fieldTypes[key].add('object')

                    if currentDepth < maxDepth:
                        if key not in nestedObjects:
                            nestedObjects[key] = {'type': 'object', 'objects': []}
                        nestedObjects[key]['objects'].append(value)
                elif isinstance(value, bool):
                    fieldTypes[key].add('boolean')
                elif isinstance(value, (int, float)):
                    fieldTypes[key].add('number')
                elif isinstance(value, str):
                    fieldTypes[key].add('string')
                else:
                    fieldTypes[key].add(type(value).__name__)

        structure = {}
        for field in fieldCounts.keys():
            structure[field] = {
                'frequency': round((fieldCounts[field] / len(objects)) * 100),
                'types': list(fieldTypes[field]),
                'occurrences': fieldCounts[field],
                'totalSamples': len(objects)
            }

            if field in nestedObjects and currentDepth < maxDepth:
                if nestedObjects[field]['type'] == 'object':
                    structure[field]['nestedStructure'] = self.analyzeObjectStructureRecursive(
                        nestedObjects[field]['objects'],
                        maxDepth,
                        currentDepth + 1
                    )
                elif nestedObjects[field]['type'] == 'array':
                    structure[field]['arrayElementStructure'] = self.analyzeObjectStructureRecursive(
                        nestedObjects[field]['elements'],
                        maxDepth,
                        currentDepth + 1
                    )

            if currentDepth < maxDepth and field in nestedObjects:
                structure[field]['depth'] = currentDepth + 1
                structure[field]['hasNestedObjects'] = True

        return structure

    # Find a relationship between two specific collections
    async def findRelationshipBetweenCollections(self, collection1, collection2, schema1, schema2, sampleSize=5, workspace_id=None):
        if not schema1 or not schema2:
            return None

        relationships = []

        # Look for potential foreign key relationships
        fields1 = list(schema1.keys())
        fields2 = list(schema2.keys())

        # Check if collection1 has fields that might reference collection2
        for field1 in fields1:
            # Common patterns for foreign keys
            possibleRefs = [
                f"{collection2[:-1]}Id",  # users -> userId
                f"{collection2[:-1]}_id",  # users -> user_id
                f"{collection2}Id",  # users -> usersId
                f"{collection2}_id",  # users -> users_id
                collection2[:-1] in field1,  # any field containing collection name
                '_id' in field1 or 'Id' in field1  # any field ending with id
            ]

            if any(pattern.lower() in field1.lower() if isinstance(pattern, str) else pattern 
                   for pattern in possibleRefs):
                # Verify the relationship by sampling data
                verified = await self.verifyRelationship(collection1, field1, collection2, '_id', sampleSize, workspace_id)
                if verified['isValid']:
                    relationships.append({
                        'type': 'foreign_key',
                        'from': collection1,
                        'fromField': field1,
                        'to': collection2,
                        'toField': '_id',
                        'strength': verified['strength'],
                        'sampleMatches': verified['matches']
                    })

        # Check reverse relationship
        for field2 in fields2:
            possibleRefs = [
                f"{collection1[:-1]}Id",
                f"{collection1[:-1]}_id",
                f"{collection1}Id",
                f"{collection1}_id",
                collection1[:-1] in field2,
                '_id' in field2 or 'Id' in field2
            ]

            if any(pattern.lower() in field2.lower() if isinstance(pattern, str) else pattern
                   for pattern in possibleRefs):
                verified = await self.verifyRelationship(collection2, field2, collection1, '_id', sampleSize, workspace_id)
                if verified['isValid']:
                    relationships.append({
                        'type': 'foreign_key',
                        'from': collection2,
                        'fromField': field2,
                        'to': collection1,
                        'toField': '_id',
                        'strength': verified['strength'],
                        'sampleMatches': verified['matches']
                    })

        return {
            'collection1': collection1,
            'collection2': collection2,
            'relationships': relationships
        } if len(relationships) > 0 else None

    # Verify if a relationship actually exists by checking sample data
    async def verifyRelationship(self, fromCollection, fromField, toCollection, toField, sampleSize=5, workspace_id=None):
        try:
            # Get sample documents from both collections
            fromDocs = await self.find(fromCollection, {}, {'limit': sampleSize}, workspace_id)
            toDocs = await self.find(toCollection, {}, {'limit': sampleSize}, workspace_id)

            if len(fromDocs) == 0 or len(toDocs) == 0:
                return {'isValid': False, 'strength': 0, 'matches': 0}

            # Extract values to check
            fromValues = []
            for doc in fromDocs:
                val = doc.get(fromField)
                if val is not None:
                    # Handle ObjectId values properly
                    if isinstance(val, dict) and '$oid' in val:
                        fromValues.append(val['$oid'])  # BSON ObjectId in JSON format
                    else:
                        fromValues.append(str(val))

            toValues = set()
            for doc in toDocs:
                val = doc.get(toField)
                if val is not None:
                    # Handle ObjectId values properly
                    if isinstance(val, dict) and '$oid' in val:
                        toValues.add(val['$oid'])  # BSON ObjectId in JSON format
                    else:
                        toValues.add(str(val))

            # Count matches
            matches = len([val for val in fromValues if val in toValues])
            strength = matches / len(fromValues) if len(fromValues) > 0 else 0

            return {
                'isValid': strength > 0.1,  # At least 10% match rate
                'strength': round(strength * 100) / 100,
                'matches': matches,
                'totalChecked': len(fromValues)
            }
        except Exception as error:
            print(f'Error verifying relationship: {error}')
            return {'isValid': False, 'strength': 0, 'matches': 0}

    # Helper method to check if a string is a valid ObjectId
    def isValidObjectId(self, value):
        """Check if a string is a valid ObjectId format"""
        if not isinstance(value, str):
            return False
        if len(value) != 24:
            return False
        return bool(re.match(r'^[0-9a-fA-F]{24}$', value))

    # Helper method to convert string IDs to ObjectId using BSON
    def processObjectIds(self, query):
        """Process query to convert string ObjectIds to BSON ObjectIds"""
        if not query:
            return query
            
        processed = copy.deepcopy(query)

        def processValue(value):
            """Recursively process values in the query"""
            if isinstance(value, str) and self.isValidObjectId(value):
                try:
                    return ObjectId(value)
                except Exception as e:
                    print(f'Failed to convert {value} to ObjectId: {e}')
                    return value
            elif isinstance(value, dict) and '$oid' in value:
                # Handle BSON ObjectId in JSON format
                try:
                    return ObjectId(value['$oid'])
                except Exception as e:
                    print(f'Failed to convert $oid {value["$oid"]} to ObjectId: {e}')
                    return value
            elif isinstance(value, list):
                return [processValue(item) for item in value]
            elif isinstance(value, dict) and value is not None:
                processedObj = {}
                for subKey, subValue in value.items():
                    processedObj[subKey] = processValue(subValue)
                return processedObj
            elif isinstance(value, ObjectId):
                # Already an ObjectId, keep as is
                return value
            return value

        # Process all fields in the query
        for key, value in processed.items():
            # Check if this field might contain ObjectId
            if key == '_id' or key.endswith('_id') or key.endswith('Id') or key.startswith('$'):
                processed[key] = processValue(value)
            elif isinstance(value, dict) and value is not None:
                processed[key] = processValue(value)

        return processed

    def processObjectIdsInPipeline(self, pipeline):
        """Process aggregation pipeline to convert ObjectIds"""
        if not pipeline:
            return pipeline
            
        processed_pipeline = []
        
        for stage in pipeline:
            if isinstance(stage, dict):
                processed_stage = {}
                for stage_key, stage_value in stage.items():
                    if stage_key in ['$match', '$lookup', '$graphLookup']:
                        # These stages may contain ObjectId references
                        processed_stage[stage_key] = self.processObjectIds(stage_value)
                    else:
                        processed_stage[stage_key] = stage_value
                processed_pipeline.append(processed_stage)
            else:
                processed_pipeline.append(stage)
                
        return processed_pipeline