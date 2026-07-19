const socket = io();

let localStream;
let pc = null;
let partnerSid = null;
let streamReady = false;
let socketReady = false;

const configuration = {
    iceServers: [
        { urls: "stun:stun.l.google.com:19302" }
    ]
};

function setStatus(text) {
    document.getElementById("status").textContent = text;
}

function startSearch() {
    if (!streamReady || !socketReady) return;
    setStatus("🔎 Looking for someone...");
    socket.emit("find-partner");
}

socket.on("connect", () => {
    socketReady = true;
    startSearch();
});

navigator.mediaDevices.getUserMedia({ video: true, audio: true })
    .then(stream => {
        localStream = stream;
        document.getElementById("localVideo").srcObject = stream;
        streamReady = true;
        startSearch();
    })
    .catch(err => {
        console.error("Media Error:", err);
        alert("Could not access camera/microphone: " + err.message);
    });

socket.on("waiting", () => {
    setStatus("🔎 Looking for someone...");
});

socket.on("matched", async ({ initiator, partner }) => {
    partnerSid = partner;
    setStatus("Connected! Say hi 👋");

    pc = createPeerConnection(partner);

    if (initiator) {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("offer", { offer: offer, to: partner });
    }
});

socket.on("offer", async ({ offer, from }) => {
    partnerSid = from;
    pc = createPeerConnection(from);

    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit("answer", { answer: answer, to: from });
});

socket.on("answer", async ({ answer }) => {
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
});

socket.on("ice-candidate", async ({ candidate }) => {
    if (!pc) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("ICE Error:", err);
    }
});

socket.on("partner-left", () => {
    setStatus("Stranger disconnected. Searching again...");
    teardownCall();
    startSearch();
});

socket.on("random-msg", ({ msg }) => {
    document.getElementById("chat").innerHTML += `<p><strong>Stranger:</strong> ${msg}</p>`;
});

function createPeerConnection(remoteSid) {
    const conn = new RTCPeerConnection(configuration);

    localStream.getTracks().forEach(track => conn.addTrack(track, localStream));

    conn.ontrack = (event) => {
        document.getElementById("remoteVideo").srcObject = event.streams[0];
        document.getElementById("remote-tile").classList.remove("hidden");
    };

    conn.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit("ice-candidate", { candidate: event.candidate, to: remoteSid });
        }
    };

    return conn;
}

function teardownCall() {
    if (pc) {
        pc.close();
        pc = null;
    }
    partnerSid = null;
    document.getElementById("remoteVideo").srcObject = null;
    document.getElementById("remote-tile").classList.add("hidden");
    document.getElementById("chat").innerHTML = "";
}

function skip() {
    setStatus("Skipping...");
    teardownCall();
    socket.emit("skip");
}

function sendMsg() {
    const input = document.getElementById("msg");
    const msg = input.value.trim();
    if (!msg || !partnerSid) return;
    socket.emit("random-msg", { msg: msg });
    document.getElementById("chat").innerHTML += `<p><strong>You:</strong> ${msg}</p>`;
    input.value = "";
}

function toggleMic() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    audioTrack.enabled = !audioTrack.enabled;
    document.getElementById("micBtn").textContent = audioTrack.enabled ? "Mute" : "Unmute";
}

function toggleCamera() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    videoTrack.enabled = !videoTrack.enabled;
    document.getElementById("camBtn").textContent = videoTrack.enabled ? "Camera Off" : "Camera On";
}

function leaveMeeting() {
    if (localStream) localStream.getTracks().forEach(track => track.stop());
    if (pc) pc.close();
    window.location.href = "/";
}

// Swipe up (mobile) = skip to next stranger
let touchStartY = 0;
document.addEventListener("touchstart", (e) => {
    touchStartY = e.touches[0].clientY;
});
document.addEventListener("touchend", (e) => {
    const touchEndY = e.changedTouches[0].clientY;
    if (touchStartY - touchEndY > 80) {
        skip();
    }
});
