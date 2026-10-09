const express = require("express");
const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Inicializar Firebase Admin (soporta Variable de Entorno en Vercel o archivo local)
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  } catch (e) {
    serviceAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, "base64").toString("utf8"));
  }
} else {
  const serviceAccountFile = fs.readdirSync(__dirname).find(f => 
    f.startsWith("crm-wa-pw-firebase-adminsdk") && f.endsWith(".json")
  );

  if (serviceAccountFile) {
    serviceAccount = JSON.parse(fs.readFileSync(path.join(__dirname, serviceAccountFile), "utf8"));
  }
}

if (!serviceAccount) {
  console.error("❌ No se encontró la configuración de Firebase (ni archivo local ni FIREBASE_SERVICE_ACCOUNT).");
  process.exit(1);
}

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

function sanitizeId(id) {
  return String(id || "").replace(/\//g, "_").trim();
}

// ------------------------------------------------------------
// ENDPOINTS DE LA API
// ------------------------------------------------------------

// 1. Estadísticas globales para el Dashboard de Analítica
app.get("/api/stats", async (req, res) => {
  try {
    const chatsSnap = await db.collection("chats").get();
    let totalChats = chatsSnap.size;
    let agentCounts = { "Haru": 0, "Brian": 0, "Sin Asignar": 0 };
    let stageCounts = { "Nuevo": 0, "Contactado": 0, "Cotización": 0, "Ganado": 0, "Perdido": 0 };

    chatsSnap.forEach(doc => {
      const data = doc.data();
      const agent = data.assignedAgent || "Sin Asignar";
      agentCounts[agent] = (agentCounts[agent] || 0) + 1;

      const stage = data.leadStage || "Nuevo";
      stageCounts[stage] = (stageCounts[stage] || 0) + 1;
    });

    const syncDoc = await db.collection("system").doc("last_sync").get();
    const syncData = syncDoc.exists ? syncDoc.data() : null;

    res.json({
      totalChats,
      totalMessages: syncData?.totalMessages || 7300,
      agentDistribution: agentCounts,
      stageDistribution: stageCounts,
      lastSync: syncData?.lastSyncDate || null
    });
  } catch (error) {
    console.error("Error en /api/stats:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Obtener lista de chats (con filtros de agente y búsqueda)
app.get("/api/chats", async (req, res) => {
  try {
    const { agent, search, stage } = req.query;
    let query = db.collection("chats");

    const snap = await query.get();
    let chats = [];

    snap.forEach(doc => {
      chats.push({ id: doc.id, ...doc.data() });
    });

    // Ordenar por fecha del último mensaje descendente
    chats.sort((a, b) => {
      const tA = a.lastMessageTimestamp ? new Date(a.lastMessageTimestamp).getTime() : 0;
      const tB = b.lastMessageTimestamp ? new Date(b.lastMessageTimestamp).getTime() : 0;
      return tB - tA;
    });

    // Filtros en memoria
    if (agent) {
      if (agent === "Sin Asignar") {
        chats = chats.filter(c => !c.assignedAgent);
      } else {
        chats = chats.filter(c => c.assignedAgent === agent);
      }
    }

    if (stage) {
      chats = chats.filter(c => (c.leadStage || "Nuevo") === stage);
    }

    if (search) {
      const q = search.toLowerCase();
      chats = chats.filter(c => 
        (c.name && c.name.toLowerCase().includes(q)) ||
        (c.phoneNumber && c.phoneNumber.includes(q)) ||
        (c.lastMessageSnippet && c.lastMessageSnippet.toLowerCase().includes(q))
      );
    }

    res.json({ total: chats.length, chats });
  } catch (error) {
    console.error("Error en /api/chats:", error);
    res.status(500).json({ error: error.message });
  }
});

// 3. Obtener mensajes de un chat específico
app.get("/api/chats/:chatId/messages", async (req, res) => {
  try {
    const chatId = sanitizeId(req.params.chatId);
    const msgsSnap = await db.collection("chats").doc(chatId).collection("messages").get();

    const messages = [];
    msgsSnap.forEach(doc => {
      messages.push(doc.data());
    });

    // Ordenar cronológicamente ascendente (los más antiguos primero)
    messages.sort((a, b) => {
      const tA = a.timestamp || (a.messageDateISO ? new Date(a.messageDateISO).getTime() : 0);
      const tB = b.timestamp || (b.messageDateISO ? new Date(b.messageDateISO).getTime() : 0);
      return tA - tB;
    });

    res.json({ total: messages.length, messages });
  } catch (error) {
    console.error("Error en /api/chats/:chatId/messages:", error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Actualizar estado del lead, agente o notas del chat
app.patch("/api/chats/:chatId", async (req, res) => {
  try {
    const chatId = sanitizeId(req.params.chatId);
    const { leadStage, assignedAgent, noteText, noteAuthor } = req.body;
    const chatRef = db.collection("chats").doc(chatId);

    const updateData = {};
    if (leadStage !== undefined) updateData.leadStage = leadStage;
    if (assignedAgent !== undefined) updateData.assignedAgent = assignedAgent;

    if (noteText) {
      const note = {
        id: Date.now().toString(),
        text: noteText,
        author: noteAuthor || "Equipo",
        createdAt: new Date().toISOString()
      };
      updateData.notes = admin.firestore.FieldValue.arrayUnion(note);
    }

    await chatRef.set(updateData, { merge: true });
    res.json({ success: true, updated: updateData });
  } catch (error) {
    console.error("Error actualizando chat:", error);
    res.status(500).json({ error: error.message });
  }
});

// 5. Motor de Analítica Avanzada con Filtros de Fecha, Tasa de Respuesta y Temas
app.get("/api/analytics", async (req, res) => {
  try {
    const { startDate, endDate, groupBy = "day", agent, topic } = req.query;

    // Cargar mensajes en memoria para cálculo instantáneo (priorizando PLAINTEXT)
    let allMessages = [];
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

    if (jsonFiles.length > 0) {
      const parsed = JSON.parse(fs.readFileSync(path.join(__dirname, jsonFiles[0].name), "utf8"));
      allMessages = parsed.messages || [];
    }

    // Reglas de clasificación temática
    const TOPIC_RULES = [
      { topic: "Ventas y Pedidos", regex: /tarjeta|terminal|costo|precio|comisi[oó]n|comprar|adquirir|cotiza|pedido|env[ií]o|promoci[oó]n|link de pago|vender|cuenta/i },
      { topic: "Capacitación y Uso", regex: /capacita|c[oó]mo funciona|c[oó]mo (se )?usa|tutorial|manual|inducci[oó]n|pasos|activar|activaci[oó]n|explicar|aprender/i },
      { topic: "Problemas y Soporte", regex: /error|falla|problema|bloque|no pasa|no funciona|rechaz|ayuda|soporte|cancel|devoluci[oó]n|reclamo|urgente|devol/i },
      { topic: "Dudas y Consultas", regex: /duda|pregunta|consulta|requisito|informaci[oó]n|horario|saber si|puedo|d[oó]nde|estatus/i },
      { topic: "Pagos y Facturación", regex: /transfer|dep[oó]sito|saldo|pago|factura|fiscal|comprobante|banco|clabe|dispersi[oó]n|abono/i }
    ];

    function classifyMessage(text) {
      for (const rule of TOPIC_RULES) {
        if (rule.regex.test(text)) return rule.topic;
      }
      return "General / Operativo";
    }

    // Rango de fechas en hora local (evita que UTC corte la jornada laboral)
    let startMs = 0;
    let endMs = Infinity;

    if (startDate) {
      startMs = new Date(`${startDate}T00:00:00`).getTime();
    }
    if (endDate) {
      endMs = new Date(`${endDate}T23:59:59.999`).getTime();
    }

    // Filtrar mensajes por fecha, agente y tema seleccionado
    const filteredMsgs = allMessages.filter(m => {
      const t = m.timestamp || (m.messageDateISO ? new Date(m.messageDateISO).getTime() : 0);
      if (t < startMs || t > endMs) return false;
      if (agent && agent !== "all") {
        const msgAgent = m.crm?.assignedAgent || "Sin Asignar";
        if (agent === "Sin Asignar" && m.crm?.assignedAgent) return false;
        if (agent !== "Sin Asignar" && msgAgent !== agent) return false;
      }

      if (topic && topic !== "all") {
        const textToAnalyze = (m.text || "") + " " + (m.chatName || "");
        const matched = classifyMessage(textToAnalyze);
        if (matched !== topic) return false;
      }

      return true;
    });

    let sentCount = 0;
    let receivedCount = 0;
    const chatInteractions = new Map(); // chatId -> { sent: 0, received: 0, firstSent: null, firstReply: null }
    const timelineMap = new Map();
    const topicCounts = {
      "Ventas y Pedidos": 0,
      "Capacitación y Uso": 0,
      "Problemas y Soporte": 0,
      "Dudas y Consultas": 0,
      "Pagos y Facturación": 0,
      "General / Operativo": 0
    };

    filteredMsgs.forEach(m => {
      const parts = String(m.id || "").split("_");
      const isSent = parts[0] === "true" || m.fromMe === true || m.direction === "sent";
      const realChatId = parts[1] || m.chatId;

      if (isSent) sentCount++;
      else receivedCount++;

      // Agrupar por chat real para tasa de respuesta
      if (!chatInteractions.has(realChatId)) {
        chatInteractions.set(realChatId, { sent: 0, received: 0, answered: false });
      }
      const inter = chatInteractions.get(realChatId);
      if (isSent) inter.sent++;
      else {
        inter.received++;
        if (inter.sent > 0) inter.answered = true;
      }

      // Clasificación temática por texto del mensaje o contexto del chat
      const textToAnalyze = (m.text || "") + " " + (m.chatName || "");
      let matchedTopic = false;
      for (const rule of TOPIC_RULES) {
        if (rule.regex.test(textToAnalyze)) {
          topicCounts[rule.topic]++;
          matchedTopic = true;
          break;
        }
      }
      if (!matchedTopic) {
        topicCounts["General / Operativo"]++;
      }

      // Agrupación temporal en hora local (evita que la tarde pase al día siguiente)
      const dateObj = new Date(m.timestamp || m.messageDateISO);
      let timeKey = "";
      if (groupBy === "week") {
        const firstDayOfYear = new Date(dateObj.getFullYear(), 0, 1);
        const pastDaysOfYear = (dateObj - firstDayOfYear) / 86400000;
        const weekNum = Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
        timeKey = `Sem ${weekNum} (${dateObj.getFullYear()})`;
      } else {
        const year = dateObj.getFullYear();
        const month = String(dateObj.getMonth() + 1).padStart(2, "0");
        const day = String(dateObj.getDate()).padStart(2, "0");
        timeKey = `${year}-${month}-${day}`; // YYYY-MM-DD local
      }

      if (!timelineMap.has(timeKey)) {
        timelineMap.set(timeKey, { key: timeKey, sent: 0, received: 0, total: 0 });
      }
      const timeSlot = timelineMap.get(timeKey);
      if (isSent) timeSlot.sent++;
      else timeSlot.received++;
      timeSlot.total++;
    });

    // Calcular tasa de respuesta
    let totalContacted = 0;
    let totalAnswered = 0;
    chatInteractions.forEach(val => {
      if (val.sent > 0) {
        totalContacted++;
        if (val.received > 0 || val.answered) totalAnswered++;
      }
    });

    const responseRate = totalContacted > 0 ? ((totalAnswered / totalContacted) * 100).toFixed(1) : 0;

    // Ordenar línea de tiempo
    const timeline = Array.from(timelineMap.values()).sort((a,b) => a.key.localeCompare(b.key));

    res.json({
      summary: {
        totalMessages: filteredMsgs.length,
        sent: sentCount,
        received: receivedCount,
        totalContacted,
        totalAnswered,
        unanswered: totalContacted - totalAnswered,
        responseRate: Number(responseRate)
      },
      timeline,
      topics: topicCounts
    });
  } catch (error) {
    console.error("Error en /api/analytics:", error);
    res.status(500).json({ error: error.message });
  }
});

// Iniciar servidor local si no estamos en entorno serverless
if (process.env.VERCEL !== "1") {
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`\n======================================================`);
    console.log(`🌐 CRM PAYWISE ACTIVO EN: http://localhost:${PORT}`);
    console.log(`👥 Accesible para tu equipo en red local: http://<TU_IP>:${PORT}`);
    console.log(`======================================================\n`);
  });
}

module.exports = app;
