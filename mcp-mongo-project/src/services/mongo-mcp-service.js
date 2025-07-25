import {MongoClient, ObjectId} from 'mongodb';
import {getSimplifiedSchema} from 'mongodb-schema';
import dotenv from 'dotenv';

dotenv.config();


class MongoDBService {
    constructor(uri = process.env.MONGODB_URI, dbName = process.env.MONGODB_NAME) {
        if (!uri) {
            throw new Error('MongoDB URI is not defined');
        }
        if (!dbName) {
            throw new Error('Database name is not defined');
        }
        this.client = new MongoClient(uri);
        this.dbName = dbName;
        this.db = null;
    }

    async connect() {
        try {
            await this.client.connect();
            this.db = this.client.db(this.dbName);
            console.log('Connected to MongoDB');
            return this.db;
        } catch (error) {
            console.error('MongoDB connection error:', error);
            throw error;
        }
    }

    async disconnect() {
        try {
            await this.client.close();
            console.log('Disconnected from MongoDB');
        } catch (error) {
            console.error('MongoDB disconnection error:', error);
            throw error;
        }
    }

    // Find documents
    async find(collectionName, query = {}, options = {}) {
        try {
            const collection = this.db.collection(collectionName);
            // Process query to handle ObjectId if needed
            query = this.processObjectIds(query);

            const {limit = 0, skip = 0, sort = {}, projection = {}} = options;
            const result = await collection.find(query)
                .sort(sort)
                .skip(skip)
                .limit(limit)
                .project(projection)
                .toArray();

            return result;
        } catch (error) {
            console.error(`Error finding documents in ${collectionName}:`, error);
            throw error;
        }
    }

    // Find one document
    async findOne(collectionName, query = {}, options = {}) {
        try {
            const collection = this.db.collection(collectionName);
            query = this.processObjectIds(query);
            const {projection = {}} = options;
            return await collection.findOne(query, {projection});
        } catch (error) {
            console.error(`Error finding document in ${collectionName}:`, error);
            throw error;
        }
    }

    // Run aggregation pipeline
    async aggregate(collectionName, pipeline, options = {}) {
        try {
            const collection = this.db.collection(collectionName);
            // Process pipeline stages that might contain ObjectId references
            pipeline = pipeline.map(stage => {
                if (stage.$match) {
                    stage.$match = this.processObjectIds(stage.$match);
                }
                return stage;
            });

            const result = await collection.aggregate(pipeline, options).toArray();
            return result;
        } catch (error) {
            console.error(`Error running aggregation on ${collectionName}:`, error);
            throw error;
        }
    }

    // Count documents
    async countDocuments(collectionName, query = {}, options = {}) {
        try {
            const collection = this.db.collection(collectionName);
            query = this.processObjectIds(query);
            return await collection.countDocuments(query, options);
        } catch (error) {
            console.error(`Error counting documents in ${collectionName}:`, error);
            throw error;
        }
    }

    // List collections
    async listCollections() {
        try {
            const collections = await this.db.listCollections().toArray();
            return collections.map(collection => collection.name);
        } catch (error) {
            console.error('Error listing collections:', error);
            throw error;
        }
    }

    // Get collection schema recursively with nested objects
    async getCollectionSchema(collectionName, sampleSize = 5, includeNestedObjects = true) {
        try {
            const collection = this.db.collection(collectionName);
            const documents = await collection.find({}).limit(sampleSize).toArray();

            if (documents.length === 0) {
                throw new Error(`Collection "${collectionName}" is empty or doesn't exist`);
            }

            const baseSchema = await getSimplifiedSchema(documents);

            let enhancedSchema = baseSchema;

            if (includeNestedObjects) {
                enhancedSchema = this.enhanceSchemaWithNestedObjects(baseSchema, documents);
            }

            return {
                collectionName,
                documentCount: documents.length,
                sampleSize,
                schema: enhancedSchema,
                nestedObjectsAnalyzed: includeNestedObjects
            };
        } catch (error) {
            console.error(`Error getting schema for ${collectionName}:`, error);
            throw error;
        }
    }

    enhanceSchemaWithNestedObjects(baseSchema, documents, maxDepth = 3) {
        const enhanced = {...baseSchema};

        Object.keys(baseSchema).forEach(field => {
            const fieldInfo = baseSchema[field];

            if (fieldInfo.types && fieldInfo.types.includes('object')) {
                const objectSamples = documents
                    .map(doc => doc[field])
                    .filter(value => typeof value === 'object' && value !== null && !Array.isArray(value));

                if (objectSamples.length > 0) {
                    enhanced[field] = {
                        ...fieldInfo,
                        objectStructure: this.analyzeObjectStructureRecursive(objectSamples, maxDepth, 0)
                    };
                }
            }

            if (fieldInfo.types && fieldInfo.types.includes('array')) {
                const arraySamples = documents
                    .map(doc => doc[field])
                    .filter(value => Array.isArray(value));

                if (arraySamples.length > 0) {
                    const arrayElements = arraySamples.flat();
                    const objectElements = arrayElements.filter(el =>
                        typeof el === 'object' && el !== null && !Array.isArray(el)
                    );

                    if (objectElements.length > 0) {
                        enhanced[field] = {
                            ...fieldInfo,
                            arrayElementStructure: this.analyzeObjectStructureRecursive(objectElements, maxDepth, 0)
                        };
                    }
                }
            }
        });

        return enhanced;
    }

    analyzeObjectStructureRecursive(objects, maxDepth = 3, currentDepth = 0) {
        const fieldCounts = {};
        const fieldTypes = {};
        const nestedObjects = {};

        objects.forEach(obj => {
            Object.keys(obj).forEach(key => {
                fieldCounts[key] = (fieldCounts[key] || 0) + 1;

                if (!fieldTypes[key]) {
                    fieldTypes[key] = new Set();
                }

                const value = obj[key];
                if (value === null) {
                    fieldTypes[key].add('null');
                } else if (Array.isArray(value)) {
                    fieldTypes[key].add('array');

                    if (currentDepth < maxDepth) {
                        const objectElements = value.filter(el =>
                            typeof el === 'object' && el !== null && !Array.isArray(el)
                        );
                        if (objectElements.length > 0) {
                            if (!nestedObjects[key]) {
                                nestedObjects[key] = {type: 'array', elements: []};
                            }
                            nestedObjects[key].elements.push(...objectElements);
                        }
                    }
                } else if (typeof value === 'object') {
                    fieldTypes[key].add('object');

                    if (currentDepth < maxDepth) {
                        if (!nestedObjects[key]) {
                            nestedObjects[key] = {type: 'object', objects: []};
                        }
                        nestedObjects[key].objects.push(value);
                    }
                } else {
                    fieldTypes[key].add(typeof value);
                }
            });
        });

        const structure = {};
        Object.keys(fieldCounts).forEach(field => {
            structure[field] = {
                frequency: Math.round((fieldCounts[field] / objects.length) * 100),
                types: Array.from(fieldTypes[field]),
                occurrences: fieldCounts[field],
                totalSamples: objects.length
            };

            if (nestedObjects[field] && currentDepth < maxDepth) {
                if (nestedObjects[field].type === 'object') {
                    structure[field].nestedStructure = this.analyzeObjectStructureRecursive(
                        nestedObjects[field].objects,
                        maxDepth,
                        currentDepth + 1
                    );
                } else if (nestedObjects[field].type === 'array') {
                    structure[field].arrayElementStructure = this.analyzeObjectStructureRecursive(
                        nestedObjects[field].elements,
                        maxDepth,
                        currentDepth + 1
                    );
                }
            }

            if (currentDepth < maxDepth && (nestedObjects[field])) {
                structure[field].depth = currentDepth + 1;
                structure[field].hasNestedObjects = true;
            }
        });

        return structure;
    }

    // Find a relationship between two specific collections
    async findRelationshipBetweenCollections(collection1, collection2, schema1, schema2, sampleSize = 5) {
        if (!schema1 || !schema2) return null;

        const relationships = [];

        // Look for potential foreign key relationships
        const fields1 = Object.keys(schema1);
        const fields2 = Object.keys(schema2);

        // Check if collection1 has fields that might reference collection2
        for (const field1 of fields1) {
            // Common patterns for foreign keys
            const possibleRefs = [
                `${collection2.slice(0, -1)}Id`, // users -> userId
                `${collection2.slice(0, -1)}_id`, // users -> user_id
                `${collection2}Id`, // users -> usersId
                `${collection2}_id`, // users -> users_id
                field1.includes(collection2.slice(0, -1)), // any field containing collection name
                field1.includes('_id') || field1.includes('Id') // any field ending with id
            ];

            if (possibleRefs.some(pattern =>
                typeof pattern === 'string' ? field1.toLowerCase().includes(pattern.toLowerCase()) : pattern
            )) {
                // Verify the relationship by sampling data
                const verified = await this.verifyRelationship(collection1, field1, collection2, '_id', sampleSize);
                if (verified.isValid) {
                    relationships.push({
                        type: 'foreign_key',
                        from: collection1,
                        fromField: field1,
                        to: collection2,
                        toField: '_id',
                        strength: verified.strength,
                        sampleMatches: verified.matches
                    });
                }
            }
        }

        // Check reverse relationship
        for (const field2 of fields2) {
            const possibleRefs = [
                `${collection1.slice(0, -1)}Id`,
                `${collection1.slice(0, -1)}_id`,
                `${collection1}Id`,
                `${collection1}_id`,
                field2.includes(collection1.slice(0, -1)),
                field2.includes('_id') || field2.includes('Id')
            ];

            if (possibleRefs.some(pattern =>
                typeof pattern === 'string' ? field2.toLowerCase().includes(pattern.toLowerCase()) : pattern
            )) {
                const verified = await this.verifyRelationship(collection2, field2, collection1, '_id', sampleSize);
                if (verified.isValid) {
                    relationships.push({
                        type: 'foreign_key',
                        from: collection2,
                        fromField: field2,
                        to: collection1,
                        toField: '_id',
                        strength: verified.strength,
                        sampleMatches: verified.matches
                    });
                }
            }
        }

        return relationships.length > 0 ? {
            collection1,
            collection2,
            relationships
        } : null;
    }

    // Verify if a relationship actually exists by checking sample data
    async verifyRelationship(fromCollection, fromField, toCollection, toField, sampleSize = 5) {
        try {
            // Get sample documents from both collections
            const fromDocs = await this.find(fromCollection, {}, {limit: sampleSize});
            const toDocs = await this.find(toCollection, {}, {limit: sampleSize});

            if (fromDocs.length === 0 || toDocs.length === 0) {
                return {isValid: false, strength: 0, matches: 0};
            }

            // Extract values to check
            const fromValues = fromDocs
                .map(doc => doc[fromField])
                .filter(val => val != null)
                .map(val => val.toString());

            const toValues = new Set(
                toDocs
                    .map(doc => doc[toField])
                    .filter(val => val != null)
                    .map(val => val.toString())
            );

            // Count matches
            const matches = fromValues.filter(val => toValues.has(val)).length;
            const strength = fromValues.length > 0 ? matches / fromValues.length : 0;

            return {
                isValid: strength > 0.1, // At least 10% match rate
                strength: Math.round(strength * 100) / 100,
                matches,
                totalChecked: fromValues.length
            };
        } catch (error) {
            console.error(`Error verifying relationship: ${error.message}`);
            return {isValid: false, strength: 0, matches: 0};
        }
    }

    // Generate summary of relationships
    generateRelationshipSummary(relationships) {
        const summary = {
            totalRelationships: relationships.length,
            strongRelationships: 0,
            weakRelationships: 0,
            collectionGroups: []
        };

        const strongThreshold = 0.5;
        const collectionConnections = {};

        relationships.forEach(rel => {
            rel.relationships.forEach(r => {
                if (r.strength >= strongThreshold) {
                    summary.strongRelationships++;
                } else {
                    summary.weakRelationships++;
                }

                // Track connections for grouping
                if (!collectionConnections[r.from]) {
                    collectionConnections[r.from] = new Set();
                }
                if (!collectionConnections[r.to]) {
                    collectionConnections[r.to] = new Set();
                }

                collectionConnections[r.from].add(r.to);
                collectionConnections[r.to].add(r.from);
            });
        });

        // Find connected groups
        const visited = new Set();
        Object.keys(collectionConnections).forEach(collection => {
            if (!visited.has(collection)) {
                const group = this.findConnectedGroup(collection, collectionConnections, visited);
                if (group.length > 1) {
                    summary.collectionGroups.push(group);
                }
            }
        });

        return summary;
    }

    // Find connected group of collections
    findConnectedGroup(startCollection, connections, visited) {
        const group = [];
        const queue = [startCollection];

        while (queue.length > 0) {
            const current = queue.shift();
            if (visited.has(current)) continue;

            visited.add(current);
            group.push(current);

            if (connections[current]) {
                connections[current].forEach(connected => {
                    if (!visited.has(connected)) {
                        queue.push(connected);
                    }
                });
            }
        }

        return group;
    }

    // Helper method to convert string IDs to ObjectId
    processObjectIds(query) {
        const processed = {...query};

        // Helper function to check if a string is a valid ObjectId
        const isValidObjectId = (str) => {
            if (typeof str !== 'string') return false;
            if (str.length !== 24) return false;
            return /^[0-9a-fA-F]{24}$/.test(str);
        };

        // Helper function to convert if valid ObjectId
        const convertToObjectId = (value) => {
            if (value instanceof ObjectId) {
                return value;
            }

            if (isValidObjectId(value)) {
                try {
                    return new ObjectId(value);
                } catch (e) {
                    console.log(`Failed to convert ${value} to ObjectId:`, e.message);
                    return value;
                }
            }

            return value;
        };

        // Recursive function to process nested objects
        const processValue = (value) => {
            if (typeof value === 'string') {
                return convertToObjectId(value);
            } else if (Array.isArray(value)) {
                return value.map(item =>
                    typeof item === 'string' ? convertToObjectId(item) : processValue(item)
                );
            } else if (typeof value === 'object' && value !== null) {
                const processedObj = {};
                Object.keys(value).forEach(subKey => {
                    processedObj[subKey] = processValue(value[subKey]);
                });
                return processedObj;
            }
            return value;
        };

        // Process all fields in the query
        Object.keys(processed).forEach(key => {
            const value = processed[key];

            // Check if this field might contain ObjectId
            if (key === '_id' || key.endsWith('_id') || key.endsWith('Id')) {
                processed[key] = processValue(value);
            } else if (typeof value === 'object' && value !== null) {
                // Handle query operators like $and, $or, $match, etc.
                if (key.startsWith('$')) {
                    processed[key] = processValue(value);
                } else {
                    // For nested objects, process recursively
                    processed[key] = processValue(value);
                }
            }
        });

        return processed;
    }
}

export default MongoDBService;