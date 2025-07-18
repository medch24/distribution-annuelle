const express = require('express');
const http = require('http');
const { MongoClient } = require('mongodb');
const socketIo = require('socket.io');
require('dotenv').config();

// Modules pour la gestion des fichiers
const fs = require('fs').promises;
const path = require('path');

const ConvertAPI = require('convertapi');
const convertapi = new ConvertAPI(process.env.CONVERTAPI_SECRET);

const app = express();
const server = http.createServer(app);
const io = socketIo(server, { maxHttpBufferSize: 1e8 });

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL;
const APP_VERSION = Date.now();
const classDatabases = {};

app.use(express.static('public'));
app.use(express.json());

async function connectToClassDatabase(className) {
    if (classDatabases[className]) return classDatabases[className];
    if (!MONGO_URL) { console.error("MONGO_URL is not defined."); return null; }
    try {
        const client = await MongoClient.connect(MONGO_URL, { useNewUrlParser: true, useUnifiedTopology: true });
        const dbName = `Classe_${className.replace(/[^a-zA-Z0-9]/g, '_')}`;
        const db = client.db(dbName);
        classDatabases[className] = db;
        console.log(`Connected to database ${dbName}`);
        return db;
    } catch (error) {
        console.error(`Error connecting to database for class ${className}:`, error);
        return null;
    }
}

io.on('connection', (socket) => {
    console.log(`Client connected: ${socket.id}`);
    socket.emit('appVersion', APP_VERSION);

    socket.on('generatePdfOnServer', async ({ docxBuffer, fileName }, callback) => {
        if (!docxBuffer) {
            return callback({ error: 'Données du document manquantes.' });
        }
        console.log('Préparation de la conversion PDF...');
        let tempDocxPath = null;
        let tempPdfPath = null;
        try {
            const timestamp = Date.now();
            tempDocxPath = path.join('/tmp', `docx-in-${timestamp}-${fileName}`);
            tempPdfPath = path.join('/tmp', `pdf-out-${timestamp}.pdf`);
            const nodeBuffer = Buffer.from(docxBuffer);
            await fs.writeFile(tempDocxPath, nodeBuffer);
            console.log(`Fichier DOCX temporaire créé à: ${tempDocxPath}`);

            const result = await convertapi.convert('pdf', {
                File: tempDocxPath
            }, 'docx');
            
            await result.file.save(tempPdfPath);
            console.log(`Fichier PDF temporaire créé à: ${tempPdfPath}`);
            
            const pdfBuffer = await fs.readFile(tempPdfPath);
            console.log('Conversion PDF et lecture terminées avec succès.');

            callback({ pdfData: pdfBuffer });
        } catch (error) {
            console.error('Erreur de ConvertAPI:', error.toString());
            let errorMessage = 'Une erreur est survenue lors de la conversion du document.';
            if (error.response && error.response.data && error.response.data.Message) {
                errorMessage = error.response.data.Message;
            }
            callback({ error: errorMessage });
        } finally {
            if (tempDocxPath) {
                try {
                    await fs.unlink(tempDocxPath);
                    console.log(`Fichier DOCX temporaire supprimé: ${tempDocxPath}`);
                } catch (cleanupError) {
                    console.error('Erreur lors de la suppression du fichier DOCX temporaire:', cleanupError.message);
                }
            }
            if (tempPdfPath) {
                 try {
                    await fs.unlink(tempPdfPath);
                    console.log(`Fichier PDF temporaire supprimé: ${tempPdfPath}`);
                } catch (cleanupError) {
                    console.error('Erreur lors de la suppression du fichier PDF temporaire:', cleanupError.message);
                }
            }
        }
    });

    // ... (le reste de vos listeners reste inchangé) ...

    socket.on('saveTable', async ({ className, sheetName, data }, callback) => {
        if (!className || !sheetName || !data) return callback({ error: "Missing data." });
        try {
            const db = await connectToClassDatabase(className);
            if (!db) return callback({ error: `Cannot connect to DB for ${className}` });
            await db.collection('tables').updateOne({ sheetName }, { $set: { data } }, { upsert: true });
            const allTablesData = await db.collection('tables').find().toArray();
            const formattedTables = allTablesData.map(table => ({ matiere: table.sheetName, data: table.data }));
            await db.collection('savedCopies').insertOne({ timestamp: new Date(), tables: formattedTables });
            if (callback) callback({ success: true });
        } catch (error) {
            console.error("Error saving table:", error);
            if (callback) callback({ error: "Error saving table" });
        }
    });

    socket.on('loadLatestCopy', async ({ className }, callback) => {
        if (!className) return callback({ error: "Class name is required." });
        try {
            const db = await connectToClassDatabase(className);
            if (!db) return callback({ error: `Cannot connect to DB for ${className}` });
            const latestCopy = await db.collection('savedCopies').find({ 'tables.0': { '$exists': true } }).sort({ timestamp: -1 }).limit(1).toArray();
            if (latestCopy.length > 0 && latestCopy[0].tables) {
                callback({ success: true, tables: latestCopy[0].tables });
            } else {
                const allTablesData = await db.collection('tables').find().toArray();
                const formattedTables = allTablesData.map(table => ({ matiere: table.sheetName, data: table.data }));
                callback({ success: true, tables: formattedTables.length > 0 ? formattedTables : [] });
            }
        } catch (error) {
            console.error("Error loading latest copy:", error);
            callback({ success: false, error: "Error loading saved data" });
        }
    });

    socket.on('loadAllSelectionsForClass', async ({ className }, callback) => {
        if (!className) return callback({ success: false, error: "Le nom de la classe est requis." });
        try {
            const db = await connectToClassDatabase(className);
            if (!db) return callback({ success: false, error: `Impossible de se connecter à la DB pour ${className}` });
            
            const allSelectionsRaw = await db.collection('selections').find({}).toArray();
            const allSelectionsBySheet = {};
            allSelectionsRaw.forEach(selection => {
                if (!allSelectionsBySheet[selection.sheetName]) {
                    allSelectionsBySheet[selection.sheetName] = {};
                }
                allSelectionsBySheet[selection.sheetName][selection.cellKey] = { unit: selection.unit, resources: selection.resources };
            });
            callback({ success: true, allSelections: allSelectionsBySheet });
        } catch (error) {
            if (error.codeName === 'NamespaceNotFound') {
                 console.log("Collection 'selections' non trouvée (normal si déjà migré ou nouvelle classe).");
                 return callback({ success: true, allSelections: {} });
            }
            console.error("Erreur lors du chargement de toutes les sélections pour la classe:", error);
            callback({ success: false, error: "Erreur serveur lors du chargement des sélections." });
        }
    });

    socket.on('deleteMatiereData', async ({ className, sheetName }, callback) => {
        if (!className || !sheetName) return callback({ error: "Nom de classe ou de matière manquant." });
        try {
            const db = await connectToClassDatabase(className);
            if (!db) return callback({ error: `Impossible de se connecter à la DB pour ${className}` });
            const deletePromises = [
                db.collection('tables').deleteOne({ sheetName: sheetName }),
                db.collection('selections').deleteMany({ sheetName: sheetName }),
                db.collection('resources').deleteMany({ sheetName: sheetName }),
                db.collection('units').deleteMany({ sheetName: sheetName })
            ];
            await Promise.all(deletePromises.map(p => p.catch(e => console.log("Avertissement:", e.message))));
            const latestCopy = await db.collection('savedCopies').find().sort({ timestamp: -1 }).limit(1).toArray();
            if (latestCopy.length > 0) {
                const copy = latestCopy[0];
                const updatedTables = copy.tables.filter(table => table.matiere !== sheetName);
                await db.collection('savedCopies').updateOne({ _id: copy._id }, { $set: { tables: updatedTables } });
            }
            console.log(`Données pour ${sheetName} dans ${className} supprimées.`);
            if (callback) callback({ success: true });
        } catch (error) {
            console.error(`Erreur suppression ${sheetName}:`, error);
            if (callback) callback({ error: "Erreur serveur lors de la suppression." });
        }
    });
    
    socket.on('disconnect', () => {
        console.log(`Client déconnecté: ${socket.id}`);
    });
});

server.listen(PORT, () => {
    console.log(`Le serveur est lancé sur le port ${PORT}`);
});