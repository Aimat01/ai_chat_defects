import { MongoClient, ObjectId } from 'mongodb';
import { getSimplifiedSchema } from 'mongodb-schema';
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
      console.log("Query BEFORE processing:", JSON.stringify(query, null, 2));
      query = this.processObjectIds(query);
      console.log("Query AFTER processing:", JSON.stringify(query, null, 2));

      const { limit = 0, skip = 0, sort = {}, projection = {} } = options;
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
      const { projection = {} } = options;
      return await collection.findOne(query, { projection });
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

  // Get collection schema
  // TODO: make it recursive for object fields
  async getCollectionSchema(collectionName, sampleSize = 5) {
    try {
      const collection = this.db.collection(collectionName);
      // Get sample documents to analyze schema
      const documents = await collection.find({}).limit(sampleSize).toArray();
      
      if (documents.length === 0) {
        throw new Error(`Collection "${collectionName}" is empty or doesn't exist`);
      }
      
      // Use mongodb-schema to analyze the documents
      const schema = await getSimplifiedSchema(documents);
      
      return {
        collectionName,
        documentCount: documents.length,
        sampleSize,
        schema
      };
    } catch (error) {
      console.error(`Error getting schema for ${collectionName}:`, error);
      throw error;
    }
  }

  // Analyze relationships between collections
  async analyzeCollectionRelationships(sampleSize = 3, maxCollections = 10) {
    try {
      const allCollections = await this.listCollections();
    
    // Limit collections to prevent timeout
    const collections = allCollections.slice(0, maxCollections);
    const relationships = [];
    const schemas = {};

    console.log(`Analyzing relationships for ${collections.length} collections with sample size ${sampleSize}`);

    // Get schemas for all collections with timeout for each
    for (const collectionName of collections) {
      try {
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`Schema analysis timeout for ${collectionName}`)), 5000);
        });
        
        const schemaPromise = this.getCollectionSchema(collectionName, sampleSize);
        const schemaInfo = await Promise.race([schemaPromise, timeoutPromise]);
        schemas[collectionName] = schemaInfo.schema;
      } catch (error) {
        console.warn(`Could not analyze schema for ${collectionName}: ${error.message}`);
        // Continue with other collections
      }
    }

    // Analyze potential relationships (limit combinations)
    const maxCombinations = 20; // Limit to prevent too many comparisons
    let combinationCount = 0;
    
    for (let i = 0; i < collections.length && combinationCount < maxCombinations; i++) {
      for (let j = i + 1; j < collections.length && combinationCount < maxCombinations; j++) {
        const collection1 = collections[i];
        const collection2 = collections[j];
        
        if (schemas[collection1] && schemas[collection2]) {
          try {
            const relationship = await this.findRelationshipBetweenCollections(
              collection1, 
              collection2, 
              schemas[collection1], 
              schemas[collection2],
              Math.min(sampleSize, 3) // Further limit sample size for relationship verification
            );
            
            if (relationship) {
              relationships.push(relationship);
            }
          } catch (error) {
            console.warn(`Error analyzing relationship between ${collection1} and ${collection2}: ${error.message}`);
          }
        }
        
        combinationCount++;
      }
    }

    return {
      totalCollections: allCollections.length,
      analyzedCollections: Object.keys(schemas).length,
      relationships,
      summary: this.generateRelationshipSummary(relationships),
      note: collections.length < allCollections.length ? 
        `Analysis limited to first ${collections.length} collections to prevent timeout` : 
        'All collections analyzed'
    };
  } catch (error) {
    console.error('Error analyzing collection relationships:', error);
    throw error;
  }
}

  // Find relationship between two specific collections
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
      const fromDocs = await this.find(fromCollection, {}, { limit: sampleSize });
      const toDocs = await this.find(toCollection, {}, { limit: sampleSize });

      if (fromDocs.length === 0 || toDocs.length === 0) {
        return { isValid: false, strength: 0, matches: 0 };
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
      return { isValid: false, strength: 0, matches: 0 };
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
    const processed = { ...query };
    
    // Helper function to check if string is a valid ObjectId
    const isValidObjectId = (str) => {
      if (typeof str !== 'string') return false;
      if (str.length !== 24) return false;
      return /^[0-9a-fA-F]{24}$/.test(str);
    };
    
    // Helper function to convert if valid ObjectId
    const convertToObjectId = (value) => {
      // Если уже ObjectId, возвращаем как есть
      if (value instanceof ObjectId) {
        return value;
      }

      // Проверяем, является ли строка валидным ObjectId
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