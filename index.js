const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const bodyParser = require('body-parser');
const ffmpeg = require('fluent-ffmpeg');
const fs = require("fs");
const crypto = require('crypto'); // tot sign our pre-signed URL
const v4 = require('./aws-signature-v4'); // to generate our pre-signed URL
const marshaller = require("@aws-sdk/eventstream-marshaller"); // for converting binary event stream messages to and from JSON
const util_utf8_node = require("@aws-sdk/util-utf8-node"); // utilities for encoding and decoding UTF8
const sampleRate = 8000;
const WebSocket = require('ws');
const eventStreamMarshaller = new marshaller.EventStreamMarshaller(util_utf8_node.toUtf8, util_utf8_node.fromUtf8);
const AWS = require('aws-sdk');
const credentials = require('./credentials');

// set region if not set (as not set by the SDK by default)
if (!AWS.config.region) {
  AWS.config.update({
    region: credentials.region,
    accessKeyId: credentials.accessKey,
    secretAccessKey: credentials.secretKey
  });
}

const comprehend = new AWS.Comprehend();
let transcription = "";
let socketError;
let transcribeException;
let socket;

let handleEventStreamMessage = function (messageJson) {
  let results = messageJson.Transcript.Results;

  if (results.length > 0) {
    if (results[0].Alternatives.length > 0) {
      let transcript = results[0].Alternatives[0].Transcript;

      // fix encoding for accented characters
      transcript = decodeURIComponent(escape(transcript));
      transcription = transcript;
    }
  }
}

function convertAudioToBinaryMessage(buffer) {
  // add the right JSON headers and structure to the message
  let audioEventMessage = getAudioEventMessage(buffer);

  //convert the JSON object + headers into a binary event stream message
  let binary = eventStreamMarshaller.marshall(audioEventMessage);

  return binary;
}

function getAudioEventMessage(buffer) {
  // wrap the audio data in a JSON envelope
  return {
    headers: {
      ':message-type': {
        type: 'string',
        value: 'event'
      },
      ':event-type': {
        type: 'string',
        value: 'AudioEvent'
      }
    },
    body: buffer
  };
}

function createPresignedUrl() {
  let endpoint = "transcribestreaming." + credentials.region + ".amazonaws.com:8443";

  // get a preauthenticated URL that we can use to establish our WebSocket
  return v4.createPresignedURL(
    'GET',
    endpoint,
    '/stream-transcription-websocket',
    'transcribe',
    crypto.createHash('sha256').update('', 'utf8').digest('hex'), {
    'key': credentials.accessKey,
    'secret': credentials.secretKey,
    'sessionToken': '',
    'protocol': 'wss',
    'expires': 15,
    'region': credentials.region,
    'query': "language-code=" + 'en-US' + "&media-encoding=pcm&sample-rate=" + sampleRate
  }
  );
}

function parseEntities(entities) {
  console.log(entities);
  if (!Array.isArray(entities)) {
    return {};
  }

  const form = {};
  for (let i = 0; i < entities.length; i++) {
    const entity = entities[i];
    if (entity.Type === "PERSON") {
      const fullName = entity.Text.split(' ');
      form.FirstName = fullName[0];
      form.LastName = fullName[1];
    }
    if (entity.Type === "QUANTITY") {
      const age = entity.Text.split(' ');
      form.Age = parseInt(age[0]);
    }
    if (entity.Type === "TITLE") {
      form.OS = entity.Text;
    }
    if (i === 3) {
      form.WFH = entity.Text;
    }
  }

  return form;
}

const app = express();

app.use(fileUpload({
  createParentPath: true
}));
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.post('/upload', async function (req, res) {
  try {
    if (!req.files || !req.files.file) {
      throw new Error('No file uploaded');
    }

    console.log(`Uploaded file: ${req.files.file.mimetype} ${req.files.file.size} bytes`);
    const fileId = new Date().getTime().toString();
    const tempFilePathIn = `uploads/${fileId}.opus`;
    const tempFilePathOut = `uploads/${fileId}.wav`;

    await req.files.file.mv(tempFilePathIn);

    await new Promise((resolve, reject) => {
      ffmpeg(tempFilePathIn)
        .format('s16le')
        .audioCodec('pcm_s16le')
        .audioFrequency(sampleRate)
        .on('error', function (err) {
          console.log('An error occurred: ' + err.message);
          reject(err);
        })
        .on('end', function () {
          console.log('Processing finished !');
          resolve();
        })
        .save(tempFilePathOut);
    });

    const file = fs.readFileSync(tempFilePathOut);

    // Pre-signed URLs are a way to authenticate a request (or WebSocket connection, in this case)
    // via Query Parameters. Learn more: https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html
    let url = createPresignedUrl();

    //open up our WebSocket connection
    socket = new WebSocket(url);
    socket.binaryType = "arraybuffer";

    // when we get audio data from the mic, send it to the WebSocket if possible
    socket.onopen = function () {
      const frameSize = 4096; 
      for (let begin = 0; begin < file.length; begin += frameSize) {
        let end = begin + frameSize;
        end = end > file.length ? file.length : end;
        const slice = file.slice(begin, end);
        let binary = convertAudioToBinaryMessage(slice);
  
        if (socket.readyState === socket.OPEN) {
          socket.send(binary);
        }
      }

      let emptyMessage = getAudioEventMessage(Buffer.from(new Buffer([])));
      let emptyBuffer = eventStreamMarshaller.marshall(emptyMessage);
      socket.send(emptyBuffer);
    };

  // handle inbound messages from Amazon Transcribe
  socket.onmessage = function (message) {
    //convert the binary event stream message to JSON
    let messageWrapper = eventStreamMarshaller.unmarshall(Buffer(message.data));
    let messageBody = JSON.parse(String.fromCharCode.apply(String, messageWrapper.body));
    if (messageWrapper.headers[":message-type"].value === "event") {
      handleEventStreamMessage(messageBody);
    }
    else {
      transcribeException = true;
      console.log(messageBody);
    }
  };

  socket.onerror = function () {
    socketError = true;
    console.log('WebSocket connection error. Try again.');
  };

  socket.onclose = async function (closeEvent) {
    console.log(transcription);

    const params = {
      LanguageCode: 'en',
      Text: transcription
    };

    const entities = await comprehend.detectEntities(params).promise();
    const form = parseEntities(entities.Entities);

    res.send({ transcription, form });
    if (!socketError && !transcribeException) {
      if (closeEvent.code != 1000) {
        console.log('Streaming Exception ' + closeEvent.reason);
      }
    }
  };
  } catch (err) {
    console.log(err);
    res.send(`rejected: ${JSON.stringify(err)}`);
  }
});

app.listen(9000, function () {
  console.log('App listening on port 9000!');
});

