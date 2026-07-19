const socket = io();

let localStream;
let mySid = null;
const peers = {};   // remoteSid -> RTCPeerConnection

const configuration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
    ]
};

let streamReady = false;
let socketReady = false;

function tryJoin() {
    if (streamReady && socketReady) {
        socket.emit("join", { room });
    }
}

socket.on("connect", () => {
    mySid = socket.id;
    socketReady = true;
    tryJoin();
});

navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
        localStream = stream;
        document.getElementById("localVideo").srcObject = stream;
        streamReady = true;
        tryJoin();
    })
    .catch(err => {
        console.error("Media Error:", err);
        alert("Could not access camera/microphone: " + err.message);
    });

// Chat messages
socket.on("message", (data) => {
    document.getElementById("chat").innerHTML += `<p>${data.msg}</p>`;
});

function sendMsg() {
    const msgInput = document.getElementById("msg");
    const msg = msgInput.value.trim();
    if (!msg) return;
    socket.emit("chat", { room: room, msg: msg });
    msgInput.value = "";
}

socket.on("room-full", () => {
    alert(`This meeting is full (max ${10} participants).`);
    window.location.href = "/";
});

function addRemoteTile(sid) {
    if (document.getElementById(`tile-${sid}`)) return;

    const tile = document.createElement("div");
    tile.className = "tile";
    tile.id = `tile-${sid}`;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    video.id = `video-${sid}`;

    const label = document.createElement("span");
    label.className = "tile-label";
    label.textContent = "Guest " + sid.slice(0, 4);

    tile.appendChild(video);
    tile.appendChild(label);
    document.getElementById("video-grid").appendChild(tile);
}

function removeRemoteTile(sid) {
    const tile = document.getElementById(`tile-${sid}`);
    if (tile) tile.remove();
    if (peers[sid]) {
        peers[sid].close();
        delete peers[sid];
    }
}

function createPeerConnection(remoteSid) {
    const pc = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => {
        pc.addTrack(track, localStream);
    });

    pc.ontrack = (event) => {
        addRemoteTile(remoteSid);
        const video = document.getElementById(`video-${remoteSid}`);
        if (video && video.srcObject !== event.streams[0]) {
            video.srcObject = event.streams[0];
        }
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", { candidate: event.candidate, to: remoteSid });
        }
    };

    pc.onconnectionstatechange = () => {
        if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
            removeRemoteTile(remoteSid);
        }
    };

    peers[remoteSid] = pc;
    return pc;
}

// A new participant joined -> everyone already in the room opens a
// connection *to* them (this is how the mesh forms).
socket.on("user-joined", async ({ sid }) => {
    const pc = createPeerConnection(sid);

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit("offer", { offer: offer, to: sid });
});

// Receive an offer targeted at us
socket.on("offer", async ({ offer, from }) => {
    const pc = createPeerConnection(from);

    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("answer", { answer: answer, to: from });
});

socket.on("answer", async ({ answer, from }) => {
    const pc = peers[from];
    if (pc) {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
    }
});

socket.on("ice-candidate", async ({ candidate, from }) => {
    const pc = peers[from];
    if (!pc) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("ICE Error:", err);
    }
});

// Someone left the meeting
socket.on("peer-left", ({ sid }) => {
    removeRemoteTile(sid);
});

function toggleMic() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    const btn = document.getElementById("micBtn");
    if (btn) btn.textContent = audioTrack.enabled ? "Mute" : "Unmute";
}

function toggleCamera() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    const btn = document.getElementById("camBtn");
    if (btn) btn.textContent = videoTrack.enabled ? "Camera Off" : "Camera On";
}

function copyLink() {
    navigator.clipboard.writeText(window.location.href);
    alert("Meeting link copied!");
}

function leaveMeeting() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
    }
    Object.keys(peers).forEach(removeRemoteTile);
    window.location.href = "/";
}
