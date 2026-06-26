      script:
        'const getAudioPath = async (text, speed, dirPath, config) => {
  const path = require("path");
  const fs = require("fs");
  const WebSocket = require("ws");
  const crypto = require("crypto");
  
  let audioName = new Date().getTime() + ".wav";
  const ttsDir = path.join(dirPath, "tts");
  
  if (!fs.existsSync(ttsDir)) {
    fs.mkdirSync(ttsDir, { recursive: true });
  }
  
  const audioPath = path.join(ttsDir, audioName);
  const audioBuffer = await getTTSAudio(text, speed, config, WebSocket, crypto);
  fs.writeFileSync(audioPath, audioBuffer);
  
  return audioPath;
};

// Protocol constants
const EventSend = {
  START_CONNECTION: 1,
  FINISH_CONNECTION: 2,
  START_SESSION: 100,
  FINISH_SESSION: 102,
  TASK_REQUEST: 200,
};
const EventRecv = {
  CONNECTION_STARTED: 50,
  CONNECTION_FAILED: 51,
  SESSION_STARTED: 150,
  SESSION_FINISHED: 152,
  SESSION_FAILED: 153,
  TTS_RESPONSE: 352,
};

// Build binary frame: header(4) + event(4) + [sid_len(4)+sid] + body_len(4) + body
const makeEventFrame = (event, sessionId, payload) => {
  const sidBuf = sessionId ? Buffer.from(sessionId) : null;
  const body = payload ? Buffer.from(JSON.stringify(payload)) : Buffer.alloc(0);
  // Size: header(4) + event(4) + [sid_len(4)+sid] + body_len(4) + body
  const size = 4 + 4 + (sidBuf ? 4 + sidBuf.length : 0) + 4 + body.length;
  const buf = Buffer.alloc(size);
  let off = 0;
  // Header: version=1, msg_type=1, flags=4, serial=1, compress=0
  buf.writeUInt8(0x11, off++); // (1<<4)|1
  buf.writeUInt8(0x44, off++); // (1<<4)|4
  buf.writeUInt8(0x10, off++); // (1<<4)|0
  buf.writeUInt8(0x00, off++);
  // Event
  buf.writeInt32BE(event, off); off += 4;
  // Session ID (optional)
  if (sidBuf) {
    buf.writeUInt32BE(sidBuf.length, off); off += 4;
    sidBuf.copy(buf, off); off += sidBuf.length;
  }
  // Body
  buf.writeUInt32BE(body.length, off); off += 4;
  if (body.length > 0) body.copy(buf, off);
  return buf;
};

// Parse response frame
const parseResponse = (frame) => {
  if (frame.length < 8) return null;
  let off = 0;
  const ver_flags = frame.readUInt8(off++); // skip
  const type_flags = frame.readUInt8(off++); // skip
  const ser_comp = frame.readUInt8(off++); // skip
  off++; // reserved
  const event = frame.readInt32BE(off); off += 4;
  let sessionId = "";
  // Check if there is session ID by looking at structure
  // After event(4), next 4 bytes could be sid_len or body_len
  // We need to determine: if event is CONNECTION_STARTED(50), no sid
  // For other events with sid, sid_len > 0 and sid is valid utf8
  // Heuristic: try reading sid_len, if it is reasonable (< 200), treat as sid
  if (off + 4 <= frame.length) {
    const maybeSidLen = frame.readUInt32BE(off);
    if (maybeSidLen > 0 && maybeSidLen < 200 && off + 4 + maybeSidLen + 4 <= frame.length) {
      const maybeSid = frame.slice(off + 4, off + 4 + maybeSidLen).toString("utf8");
      // Check if it looks like a UUID-like string
      if (/^[a-zA-Z0-9_-]+$/.test(maybeSid)) {
        sessionId = maybeSid;
        off += 4 + maybeSidLen;
      }
    }
  }
  if (off + 4 > frame.length) {
    return { event, sessionId, payload: {}, audio: Buffer.alloc(0) };
  }
  const bodyLen = frame.readUInt32BE(off); off += 4;
  if (event === EventRecv.TTS_RESPONSE) {
    return { event, sessionId, payload: {}, audio: frame.slice(off, off + bodyLen) };
  }
  let payload = {};
  if (bodyLen > 0 && off + bodyLen <= frame.length) {
    try { payload = JSON.parse(frame.slice(off, off + bodyLen).toString()); } catch(e) {}
  }
  return { event, sessionId, payload, audio: Buffer.alloc(0) };
};

const getTTSAudio = async (text, speed, config, WebSocket, crypto) => {
  const apiKey = config.api_key;
  const resourceId = config.resource_id || "seed-tts-2.0";
  const speaker = config.speaker || "zh_female_vv_uranus_bigtts";
  
  if (!apiKey) throw new Error("璇烽厤缃伀灞卞紩鎿?API Key");
  
  const wsUri = "wss://openspeech.bytedance.com/api/v3/tts/bidirection";
  const sessionId = crypto.randomUUID().replace(/-/g, "");
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUri, {
      headers: {
        "X-Api-Key": apiKey,
        "X-Api-Resource-Id": resourceId,
      },
    });
    
    const audioChunks = [];
    let resolved = false;
    
    const safeResolve = (buf) => {
      if (!resolved) { resolved = true; resolve(buf); }
    };
    const safeReject = (err) => {
      if (!resolved) { resolved = true; reject(err); }
    };
    
    ws.on("open", () => {
      ws.send(makeEventFrame(EventSend.START_CONNECTION, "", {}));
    });
    
    ws.on("message", (data) => {
      const parsed = parseResponse(data);
      if (!parsed) return;
      
      switch (parsed.event) {
        case EventRecv.CONNECTION_STARTED:
          // Start session
          ws.send(makeEventFrame(EventSend.START_SESSION, sessionId, {
            user: { uid: "koodo_reader" },
            event: EventSend.START_SESSION,
            namespace: "BidirectionalTTS",
            req_params: {
              text: "",
              speaker: speaker,
              audio_params: { format: "pcm", sample_rate: 24000 },
            },
          }));
          break;
        case EventRecv.SESSION_STARTED:
          // Send task
          ws.send(makeEventFrame(EventSend.TASK_REQUEST, sessionId, {
            user: { uid: "koodo_reader" },
            event: EventSend.TASK_REQUEST,
            namespace: "BidirectionalTTS",
            req_params: {
              text: text,
              speaker: speaker,
              audio_params: { format: "pcm", sample_rate: 24000 },
            },
          }));
          // Finish session
          ws.send(makeEventFrame(EventSend.FINISH_SESSION, sessionId, {}));
          break;
        case EventRecv.TTS_RESPONSE:
          if (parsed.audio && parsed.audio.length > 0) {
            audioChunks.push(parsed.audio);
          }
          break;
        case EventRecv.SESSION_FINISHED:
          ws.send(makeEventFrame(EventSend.FINISH_CONNECTION, "", {}));
          setTimeout(() => {
            try { ws.close(); } catch(e) {}
            const pcm = Buffer.concat(audioChunks);
            const wav = createWav(pcm, 24000, 1, 16);
            safeResolve(wav);
          }, 100);
          break;
        case EventRecv.SESSION_FAILED:
        case EventRecv.CONNECTION_FAILED:
          safeReject(new Error("TTS澶辫触: " + JSON.stringify(parsed.payload)));
          try { ws.close(); } catch(e) {}
          break;
      }
    });
    
    ws.on("error", (err) => safeReject(err));
    ws.on("close", () => {
      if (!resolved) {
        const pcm = Buffer.concat(audioChunks);
        if (pcm.length > 0) {
          safeResolve(createWav(pcm, 24000, 1, 16));
        } else {
          safeReject(new Error("WebSocket鍏抽棴锛屾湭鏀跺埌闊抽鏁版嵁"));
        }
      }
    });
    
    setTimeout(() => {
      if (!resolved) {
        try { ws.close(); } catch(e) {}
        safeReject(new Error("TTS瓒呮椂"));
      }
    }, 30000);
  });
};

const createWav = (pcm, sr, ch, bits) => {
  const br = sr * ch * bits / 8;
  const ba = ch * bits / 8;
  const ds = pcm.length;
  const buf = Buffer.alloc(44 + ds);
  let o = 0;
  buf.write("RIFF", o); o+=4;
  buf.writeUInt32LE(36+ds, o); o+=4;
  buf.write("WAVE", o); o+=4;
  buf.write("fmt ", o); o+=4;
  buf.writeUInt32LE(16, o); o+=4;
  buf.writeUInt16LE(1, o); o+=2;
  buf.writeUInt16LE(ch, o); o+=2;
  buf.writeUInt32LE(sr, o); o+=4;
  buf.writeUInt32LE(br, o); o+=4;
  buf.writeUInt16LE(ba, o); o+=2;
  buf.writeUInt16LE(bits, o); o+=2;
  buf.write("data", o); o+=4;
  buf.writeUInt32LE(ds, o); o+=4;
  pcm.copy(buf, o);
  return buf;
};

global.getAudioPath = getAudioPath;
',
    },
