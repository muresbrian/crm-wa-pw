const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// ============================================================
// IMPORTADOR INTELIGENTE A GOOGLE FIRESTORE
// Carga, Deduplicación y Preservación de Estados del CRM
// ============================================================

async function runImport() {
  console.log("🚀 Iniciando Importador Inteligente a Google Cloud Firestore...");

  // 1. Localizar archivo de credenciales de Firebase
  const serviceAccountFile = fs.readdirSync(__dirname).find(f => 
    f.startsWith("crm-wa-pw-firebase-adminsdk") && f.endsWith(".json")
  );

  if (!serviceAccountFile) {
    console.error("❌ No se encontró la clave privada de Firebase en la carpeta.");
    process.exit(1);
  }

  const serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, serviceAccountFile), "utf8"));

  // 2. Localizar el JSON más reciente con todos los chats (priorizando PLAINTEXT)
  const jsonFiles = fs.readdirSync(__dirname)
    .filter(f => f.startsWith("whatsapp_crm_ALL_CHATS") && f.endsWith(".json"))
    .map(f => ({
      name: f,
      isPlaintext: f.includes("PLAINTEXT"),
      time: fs.statSync(path.join(__dirname, f)).mtime.getTime()
    }))
    .sort((a, b) => {
      if (a.isPlaintext && !b.isPlaintext) return -1;
      if (!a.isPlaintext && b.isPlaintext) return 1;
      return b.time - a.time;
    });

  if (jsonFiles.length === 0) {
    console.error("❌ No se encontró ningún archivo 'whatsapp_crm_ALL_CHATS_...json' para importar.");
    process.exit(1);
  }

  const targetFile = jsonFiles[0].name;
  console.log(`📄 Archivo origen seleccionado: ${targetFile}`);
  const rawData = JSON.parse(fs.readFileSync(path.join(__dirname, targetFile), "utf8"));

  // 3. Inicializar Firebase Admin
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });

  const db = admin.firestore();
  console.log(`🔥 Conectado exitosamente al proyecto Firestore: ${serviceAccount.project_id}`);

  // Sanitizar IDs para Firestore (evitar '/' en los nombres de documentos)
  function sanitizeId(id) {
    return String(id || "").replace(/\//g, "_").trim();
  }

  const chats = rawData.chats || [];
  const messages = rawData.messages || [];

  console.log(`📦 Preparando importación:`);
  console.log(`- ${chats.length} chats`);
  console.log(`- ${messages.length} mensajes`);

  // Agrupar mensajes por chat para asociar último mensaje y subcolecciones
  const messagesByChat = new Map();
  messages.forEach(m => {
    const cId = sanitizeId(m.chatId);
    if (!messagesByChat.has(cId)) {
      messagesByChat.set(cId, []);
    }
    messagesByChat.get(cId).push(m);
  });

  // 4. Subir CHATS en lotes de 400 (el límite de Firestore es 500 por lote)
  console.log("\n🔄 Sincronizando chats (upsert con merge)...");
  let chatBatch = db.batch();
  let chatOpCount = 0;
  let totalChatsUploaded = 0;

  for (const c of chats) {
    const docId = sanitizeId(c.chatId);
    if (!docId) continue;

    const chatRef = db.collection("chats").doc(docId);
    
    // Obtener último mensaje
    const chatMsgs = messagesByChat.get(docId) || [];
    let snippet = "";
    if (chatMsgs.length > 0) {
      const lastMsg = chatMsgs[chatMsgs.length - 1];
      snippet = lastMsg.text ? lastMsg.text.slice(0, 100) : (lastMsg.type !== "chat" ? `[${lastMsg.type}]` : "");
    }

    // Datos del chat
    const chatData = {
      chatId: c.chatId,
      name: c.name || "Conversación",
      phoneNumber: c.phoneNumber || null,
      assignedAgent: c.assignedAgent || null,
      chatLists: c.chatLists || [],
      isGroup: !!c.isGroup,
      unreadCount: c.unreadCount || 0,
      lastMessageTimestamp: c.lastMessageTimestamp || null,
      lastMessageSnippet: snippet,
      updatedAt: new Date().toISOString()
    };

    // IMPORTANTE: { merge: true } asegura que NO se borren notas previas ni estados de venta (leadStage)
    chatBatch.set(chatRef, chatData, { merge: true });
    chatOpCount++;

    if (chatOpCount >= 400) {
      await chatBatch.commit();
      totalChatsUploaded += chatOpCount;
      process.stdout.write(`  Chats guardados: ${totalChatsUploaded}/${chats.length}\r`);
      chatBatch = db.batch();
      chatOpCount = 0;
    }
  }

  if (chatOpCount > 0) {
    await chatBatch.commit();
    totalChatsUploaded += chatOpCount;
  }
  console.log(`\n✅ ${totalChatsUploaded} chats sincronizados correctamente.`);

  // 5. Subir MENSAJES en lotes
  console.log("\n🔄 Sincronizando mensajes (deduplicación por ID)...");
  let msgBatch = db.batch();
  let msgOpCount = 0;
  let totalMsgsUploaded = 0;

  for (const m of messages) {
    const parentChatId = sanitizeId(m.chatId);
    const rawId = m.id?._serialized || m.id?.$1 || (typeof m.id === "object" ? `${m.id?.fromMe}_${m.id?.remote}_${m.id?.id}` : m.id);
    const msgId = sanitizeId(rawId);
    if (!parentChatId || !msgId) continue;

    // Guardar en la subcolección: chats/{chatId}/messages/{msgId}
    const msgRef = db.collection("chats").doc(parentChatId).collection("messages").doc(msgId);

    const msgData = {
      id: rawId,
      chatId: m.chatId,
      fromMe: !!m.fromMe,
      sender: m.sender || null,
      direction: m.direction || (m.fromMe ? "sent" : "received"),
      text: m.text || "",
      type: m.type || "chat",
      timestamp: m.timestamp || null,
      messageDateISO: m.messageDateISO || null,
      hasMedia: !!m.hasMedia,
      assignedAgent: m.crm?.assignedAgent || null,
      chatLists: m.crm?.chatLists || []
    };

    msgBatch.set(msgRef, msgData, { merge: true });
    msgOpCount++;

    if (msgOpCount >= 400) {
      await msgBatch.commit();
      totalMsgsUploaded += msgOpCount;
      process.stdout.write(`  Mensajes guardados: ${totalMsgsUploaded}/${messages.length}\r`);
      msgBatch = db.batch();
      msgOpCount = 0;
    }
  }

  if (msgOpCount > 0) {
    await msgBatch.commit();
    totalMsgsUploaded += msgOpCount;
  }
  console.log(`\n✅ ${totalMsgsUploaded} mensajes sincronizados en Firestore.`);

  // 6. Guardar metadata global de sincronización
  await db.collection("system").doc("last_sync").set({
    lastSyncDate: new Date().toISOString(),
    sourceFile: targetFile,
    totalChats: totalChatsUploaded,
    totalMessages: totalMsgsUploaded,
    agentDistribution: rawData.agentDistribution || {}
  }, { merge: true });

  console.log("\n🎉 ¡IMPORTACIÓN EXITOSA! Tu base de datos en Google Firestore está 100% actualizada.");
  process.exit(0);
}

runImport().catch(err => {
  console.error("❌ Error durante la importación:", err);
  process.exit(1);
});
