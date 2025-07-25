import {MongoClient} from 'mongodb';
import dotenv from 'dotenv';

dotenv.config();

const mongoUrl = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_NAME;

let db;
MongoClient.connect(mongoUrl).then(client => {
    db = client.db(dbName);
});

export async function authorize(accessToken, workspaceID, isGlobalScope = false) {
    if (!accessToken) throw new Error('Authorization header not found');
    if (!workspaceID && !isGlobalScope) throw new Error('Workspace header not found');
    let session;
    try {
        session = await db.collection('sessions').findOne({_id: accessToken});
        if (!session) throw new Error('Session not found');
    } catch (e) {
        throw new Error('DB error');
    }
    if (!session.user.is_activated) throw new Error('User is not activated');
    if (session.user.state === 'ARCHIVED') throw new Error('User is archived');
    // const path = req.route.path;
    // const scopes = session.acl?.[path];
    // if (!scopes) return res.status(403).json({error: 'Forbidden'});
    //
    // let d;
    // let found = false;
    // for (const scope of scopes) {
    //     if (scope[workspaceID] !== undefined) {
    //         d = scope[workspaceID];
    //         found = true;
    //         break;
    //     }
    // }
    // if (!found) return res.status(403).json({error: 'Forbidden'});
    //
    // let binary = d.toString(2).padStart(4, '0').split('');
    // switch (req.method) {
    //     case 'POST':
    //         if (binary[0] !== '1') return res.status(403).json({error: 'Forbidden'});
    //         break;
    //     case 'GET':
    //         if (binary[1] !== '1') return res.status(403).json({error: 'Forbidden'});
    //         break;
    //     case 'PUT':
    //         if (binary[2] !== '1') return res.status(403).json({error: 'Forbidden'});
    //         break;
    //     case 'DELETE':
    //         if (binary[3] !== '1') return res.status(403).json({error: 'Forbidden'});
    //         break;
    // }

}