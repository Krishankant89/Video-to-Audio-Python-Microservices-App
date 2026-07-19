import os
import secrets
import string

from flask import Flask, render_template, redirect, url_for, request
from flask_socketio import SocketIO, join_room, emit

app = Flask(__name__)
app.config['SECRET_KEY'] = 'secret'

socketio = SocketIO(app)

ALPHABET = string.ascii_lowercase + string.digits
MAX_ROOM_SIZE = 10

# ---- Private meeting rooms (mesh, up to MAX_ROOM_SIZE people) ----
room_sockets = {}   # room_id -> set of sids currently in that room
sid_room = {}       # sid -> room_id (for cleanup on disconnect)

# ---- Omegle-style random 1:1 matching ----
waiting_queue = []  # list of sids waiting for a partner
pairs = {}          # sid -> partner sid


def generate_room_code():
    """Generate a Google-Meet-style private room code, e.g. abc-defg-hij."""
    def chunk(n):
        return "".join(secrets.choice(ALPHABET) for _ in range(n))
    return f"{chunk(3)}-{chunk(4)}-{chunk(3)}"


@app.route("/")
def home():
    return render_template("index.html")


@app.route("/create")
def create_room():
    room_id = generate_room_code()
    while room_id in room_sockets:
        room_id = generate_room_code()
    return redirect(url_for("room", room_id=room_id))


@app.route("/room/<room_id>")
def room(room_id):
    return render_template("room.html", room_id=room_id)


@app.route("/random-chat")
def random_chat():
    return render_template("random.html")


# ---------------------------------------------------------------------
# Private meeting rooms - mesh signaling (everyone connects to everyone)
# ---------------------------------------------------------------------

@socketio.on("join")
def handle_join(data):
    room = data["room"]
    sid = request.sid

    members = room_sockets.setdefault(room, set())

    if len(members) >= MAX_ROOM_SIZE:
        emit("room-full")
        return

    members.add(sid)
    sid_room[sid] = room
    join_room(room)

    # Tell everyone already in the room about the newcomer so each of them
    # opens a peer connection *to* the newcomer (mesh formation).
    emit("user-joined", {"sid": sid}, room=room, include_self=False)
    emit("message", {"msg": "A new user joined"}, room=room)


@socketio.on("chat")
def handle_chat(data):
    emit("message", {"msg": data["msg"]}, room=data["room"])


# ---------------------------------------------------------------------
# Random ("Omegle-style") 1:1 matching
# ---------------------------------------------------------------------

def try_match(sid):
    while waiting_queue:
        other = waiting_queue.pop(0)
        if other == sid:
            continue
        pairs[sid] = other
        pairs[other] = sid
        emit("matched", {"initiator": True, "partner": other}, room=sid)
        emit("matched", {"initiator": False, "partner": sid}, room=other)
        return
    waiting_queue.append(sid)
    emit("waiting", {}, room=sid)


@socketio.on("find-partner")
def find_partner():
    sid = request.sid
    if sid in pairs or sid in waiting_queue:
        return
    try_match(sid)


@socketio.on("skip")
def skip():
    sid = request.sid
    partner = pairs.pop(sid, None)
    if partner:
        pairs.pop(partner, None)
        emit("partner-left", {}, room=partner)
    if sid in waiting_queue:
        waiting_queue.remove(sid)
    try_match(sid)


@socketio.on("random-msg")
def random_msg(data):
    partner = pairs.get(request.sid)
    if partner:
        emit("random-msg", {"msg": data["msg"]}, room=partner)


# ---------------------------------------------------------------------
# Shared WebRTC signaling relay (both features use "to"/"from" targeting)
# ---------------------------------------------------------------------

@socketio.on("offer")
def offer(data):
    payload = {"offer": data["offer"], "from": request.sid}
    emit("offer", payload, room=data["to"])


@socketio.on("answer")
def answer(data):
    payload = {"answer": data["answer"], "from": request.sid}
    emit("answer", payload, room=data["to"])


@socketio.on("ice-candidate")
def ice_candidate(data):
    payload = {"candidate": data["candidate"], "from": request.sid}
    emit("ice-candidate", payload, room=data["to"])


@socketio.on("disconnect")
def handle_disconnect():
    sid = request.sid

    # Clean up private meeting room membership
    room = sid_room.pop(sid, None)
    if room and room in room_sockets:
        room_sockets[room].discard(sid)
        if room_sockets[room]:
            emit("peer-left", {"sid": sid}, room=room)
        else:
            room_sockets.pop(room, None)

    # Clean up random-chat queue/pairing
    if sid in waiting_queue:
        waiting_queue.remove(sid)
    partner = pairs.pop(sid, None)
    if partner:
        pairs.pop(partner, None)
        emit("partner-left", {}, room=partner)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    socketio.run(app, host="0.0.0.0", port=port)