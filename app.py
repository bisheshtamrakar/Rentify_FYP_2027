import hashlib
import hmac
import json
import os
import re
import secrets
import sqlite3
import threading
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

import bcrypt
from fastapi import Depends, FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse, Response
from pymongo import ASCENDING, MongoClient
from pymongo.errors import DuplicateKeyError

ROOT = Path(__file__).resolve().parent
MONGO_URI = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
MONGO_DATABASE = os.getenv("MONGODB_DATABASE", "rentify")
SESSION_SECRET = os.getenv("SESSION_SECRET", "")
if not SESSION_SECRET:
    SESSION_SECRET = secrets.token_urlsafe(48)
    print("SESSION_SECRET is not configured; sessions will be cleared when the server restarts.")

client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
db = client[MONGO_DATABASE]
write_lock = threading.RLock()
auth_attempts = defaultdict(deque)
auth_attempts_lock = threading.Lock()
COOKIE_NAME = "rentify_session"
ALLOWED_CATEGORIES = {
    "Electronics", "Construction", "Fashion", "Vehicles", "Kitchen",
    "Events", "Camping", "Furniture", "Cleaning", "Sports", "Other",
}
DEFAULT_IMAGE = (
    "https://images.unsplash.com/photo-1494438639946-1ebd1d20bf85"
    "?auto=format&fit=crop&w=900&q=80"
)
SEED_LISTINGS = [
    ("Canon DSLR Camera", "Electronics", 1200, "Patan, Lalitpur",
     "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=900&q=80",
     "Capture sharp photos and videos for events, travel, or content creation."),
    ("Professional Drill Machine", "Construction", 500, "Jawalakhel, Lalitpur",
     "https://images.unsplash.com/photo-1504148455328-c376907d081c?auto=format&fit=crop&w=900&q=80",
     "A practical drill machine for household repairs and small projects."),
    ("Party Wear Dress", "Fashion", 800, "Kupondole, Lalitpur",
     "https://images.unsplash.com/photo-1595777457583-95e059d581b8?auto=format&fit=crop&w=900&q=80",
     "An elegant outfit for celebrations, photoshoots, and special occasions."),
    ("Mountain Bike", "Sports", 700, "Patan, Lalitpur",
     "https://images.unsplash.com/photo-1485965120184-e220f721d03e?auto=format&fit=crop&w=900&q=80",
     "A bicycle for recreational rides and short outdoor adventures."),
    ("Camping Tent", "Camping", 600, "Bhaktapur",
     "https://images.unsplash.com/photo-1478131143081-80f7f84ca84d?auto=format&fit=crop&w=900&q=80",
     "A camping tent for outdoor trips and weekend adventures."),
    ("Sofa Set", "Furniture", 1500, "Kathmandu",
     "https://images.unsplash.com/photo-1555041469-a586c61ea9bc?auto=format&fit=crop&w=900&q=80",
     "A comfortable sofa set for events, photoshoots, or short-term furnishing."),
    ("Portable Projector", "Electronics", 1000, "Baneshwor, Kathmandu",
     "https://images.unsplash.com/photo-1478720568477-152d9b164e26?auto=format&fit=crop&w=900&q=80",
     "A portable projector for presentations, movie nights, and small events."),
    ("Kitchen Mixer", "Kitchen", 350, "Lagankhel, Lalitpur",
     "https://images.unsplash.com/photo-1556911220-e15b29be8c8f?auto=format&fit=crop&w=900&q=80",
     "A kitchen mixer for temporary cooking needs and small gatherings."),
    ("Event Speaker", "Events", 900, "Thamel, Kathmandu",
     "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=80",
     "A speaker for small gatherings, celebrations, and indoor events."),
    ("Car Cleaning Vacuum", "Cleaning", 400, "Imadol, Lalitpur",
     "https://images.unsplash.com/photo-1527515637462-cff94eecc1ac?auto=format&fit=crop&w=900&q=80",
     "A vacuum cleaner for car interiors and small cleaning jobs."),
    ("Scooter", "Vehicles", 1800, "Patan, Lalitpur",
     "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=80",
     "A scooter for local travel. Confirm licence, insurance, and documents with the owner."),
    ("Folding Table and Chairs", "Events", 700, "Kirtipur, Kathmandu",
     "https://images.unsplash.com/photo-1519167758481-83f550bb49b3?auto=format&fit=crop&w=900&q=80",
     "Folding furniture for parties, meetings, and temporary event setups."),
]


def now_utc():
    return datetime.now(timezone.utc)


def kathmandu_today():
    return datetime.now(timezone.utc).astimezone(
        timezone(timedelta(hours=5, minutes=45))
    ).date()


def as_iso(value):
    if isinstance(value, datetime):
        return value.isoformat()
    return value


def end_date(start_date, duration_days):
    return (date.fromisoformat(start_date) + timedelta(days=duration_days - 1)).isoformat()


def parse_date(value):
    if not isinstance(value, str):
        return None
    try:
        parsed = date.fromisoformat(value)
        return parsed if parsed.isoformat() == value else None
    except ValueError:
        return None


def public_user(user):
    return {
        "id": str(user["_id"]),
        "name": user["name"],
        "email": user["email"],
        "phone": user["phone"],
    }


def hash_password(password):
    digest = hashlib.sha256(password.encode()).digest()
    return "bcrypt-sha256$" + bcrypt.hashpw(digest, bcrypt.gensalt()).decode()


def verify_password(password, stored_hash):
    try:
        if stored_hash.startswith("bcrypt-sha256$"):
            digest = hashlib.sha256(password.encode()).digest()
            return bcrypt.checkpw(digest, stored_hash.removeprefix("bcrypt-sha256$").encode())
        return bcrypt.checkpw(password.encode()[:72], stored_hash.encode())
    except ValueError:
        return False


def make_session(user_id, max_age):
    payload = f"{user_id}:{int(datetime.now(timezone.utc).timestamp()) + max_age}:{secrets.token_urlsafe(12)}"
    signature = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return f"{payload}:{signature}"


def session_user_id(request):
    token = request.cookies.get(COOKIE_NAME, "")
    try:
        user_id, expires_at, nonce, supplied_signature = token.rsplit(":", 3)
    except ValueError:
        return None
    payload = f"{user_id}:{expires_at}:{nonce}"
    expected = hmac.new(SESSION_SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(supplied_signature, expected):
        return None
    try:
        if int(expires_at) <= int(datetime.now(timezone.utc).timestamp()):
            return None
    except ValueError:
        return None
    return user_id


def current_user(request: Request):
    user_id = session_user_id(request)
    return db.users.find_one({"_id": user_id}) if user_id else None


def require_user(request: Request):
    user = current_user(request)
    if not user:
        raise ApiError(401, "Please log in to continue.")
    return user


async def request_body(request):
    try:
        raw_body = await request.body()
        if len(raw_body) > 32 * 1024:
            raise ApiError(413, "Request body is too large.")
        body = json.loads(raw_body)
    except (json.JSONDecodeError, UnicodeDecodeError):
        raise ApiError(400, "Request body must be valid JSON.")
    if not isinstance(body, dict):
        raise ApiError(400, "Request body must be a JSON object.")
    return body


def enforce_auth_limit(request):
    address = request.client.host if request.client else "unknown"
    now = time.monotonic()
    with auth_attempts_lock:
        attempts = auth_attempts[address]
        while attempts and now - attempts[0] >= 15 * 60:
            attempts.popleft()
        if len(attempts) >= 30:
            raise ApiError(429, "Too many authentication attempts. Try again later.")
        attempts.append(now)


class ApiError(Exception):
    def __init__(self, status_code, message):
        self.status_code = status_code
        self.message = message


def error_response(error):
    return JSONResponse(status_code=error.status_code, content={"error": error.message})


def notify_user(user_id, title, message, kind, booking_id=None, scheduled_date=None, key=None):
    notification_id = key or str(uuid.uuid4())
    db.notifications.update_one(
        {"_id": notification_id},
        {"$setOnInsert": {
            "userId": str(user_id),
            "title": title,
            "message": message,
            "type": kind,
            "bookingId": str(booking_id) if booking_id else None,
            "scheduledDate": scheduled_date,
            "createdAt": now_utc(),
            "read": False,
        }},
        upsert=True,
    )


def booking_overlaps(item_id, start_date, duration_days, except_id=None):
    requested_end = end_date(start_date, duration_days)
    query = {"itemId": str(item_id), "status": {"$in": ["pending", "approved"]}}
    if except_id:
        query["_id"] = {"$ne": str(except_id)}
    for booking in db.bookings.find(query, {"startDate": 1, "durationDays": 1}):
        other_end = end_date(booking["startDate"], booking["durationDays"])
        if start_date <= other_end and booking["startDate"] <= requested_end:
            return True
    return False


def public_item(item):
    owner = db.users.find_one({"_id": item["ownerId"]}, {"name": 1})
    today = kathmandu_today().isoformat()
    active_booking = db.bookings.find_one({
        "itemId": str(item["_id"]),
        "status": "approved",
        "startDate": {"$lte": today},
        "durationDays": {"$gt": 0},
    })
    rented_until = None
    if active_booking:
        active_end = end_date(active_booking["startDate"], active_booking["durationDays"])
        if active_end >= today:
            rented_until = active_end
    return {
        "id": str(item["_id"]),
        "ownerId": item["ownerId"],
        "ownerName": owner["name"] if owner else "Owner",
        "name": item["name"],
        "category": item["category"],
        "price": item["price"],
        "unit": "day",
        "location": item["location"],
        "image": item["image"],
        "description": item["description"],
        "ownerRating": 5,
        "rentedUntil": rented_until,
    }


def public_booking(booking, user_id):
    item = db.items.find_one({"_id": booking["itemId"]})
    renter = db.users.find_one({"_id": booking["renterId"]})
    owner = db.users.find_one({"_id": item["ownerId"]}) if item else None
    if not item or not renter:
        return None
    return {
        "id": str(booking["_id"]),
        "itemId": str(item["_id"]),
        "itemName": item["name"],
        "renterId": str(renter["_id"]),
        "renterName": renter["name"],
        "renterEmail": renter["email"],
        "ownerId": str(item["ownerId"]),
        "ownerName": owner["name"] if owner else "Owner",
        "startDate": booking["startDate"],
        "durationDays": booking["durationDays"],
        "endDate": end_date(booking["startDate"], booking["durationDays"]),
        "pickupLocation": booking["pickupLocation"],
        "dailyPrice": item["price"],
        "totalPrice": booking["totalPrice"],
        "status": booking["status"],
        "paymentStatus": booking["paymentStatus"],
        "paymentMethod": booking.get("paymentMethod"),
        "createdAt": as_iso(booking["createdAt"]),
        "isRenter": str(renter["_id"]) == str(user_id),
    }


def migrate_sqlite_data():
    sqlite_path = ROOT / "data" / "rentify.sqlite"
    if not sqlite_path.exists() or db.users.count_documents({}) > 0:
        return
    with sqlite3.connect(f"file:{sqlite_path.as_posix()}?mode=ro", uri=True) as source:
        source.row_factory = sqlite3.Row
        tables = {row["name"] for row in source.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )}
        if not {"users", "items", "bookings"}.issubset(tables):
            return
        users = [dict(row) for row in source.execute("SELECT * FROM users")]
        items = [dict(row) for row in source.execute("SELECT * FROM items")]
        bookings = [dict(row) for row in source.execute("SELECT * FROM bookings")]
    if users:
        db.users.insert_many([{
            "_id": str(row["id"]),
            "name": row["name"],
            "email": row["email"].strip().lower(),
            "phone": row["phone"],
            "passwordHash": row["password_hash"],
            "createdAt": row.get("created_at") or now_utc(),
        } for row in users], ordered=False)
        db.items.insert_many([{
            "_id": str(row["id"]),
            "ownerId": str(row["owner_id"]),
            "name": row["name"],
            "category": row["category"],
            "price": row["price"],
            "location": row["location"],
            "image": row["image"],
            "description": row["description"],
            "createdAt": row.get("created_at") or now_utc(),
        } for row in items], ordered=False)
        if bookings:
            db.bookings.insert_many([{
                "_id": str(row["id"]),
                "itemId": str(row["item_id"]),
                "renterId": str(row["renter_id"]),
                "startDate": row["start_date"],
                "durationDays": row["duration_days"],
                "pickupLocation": row["pickup_location"],
                "totalPrice": row["total_price"],
                "status": row["status"],
                "paymentStatus": row["payment_status"],
                "paymentMethod": row.get("payment_method"),
                "createdAt": row.get("created_at") or now_utc(),
            } for row in bookings], ordered=False)
        print(f"Migrated {len(users)} users, {len(items)} products, and {len(bookings)} bookings from SQLite.")


def initialize_database():
    client.admin.command("ping")
    db.users.create_index([("email", ASCENDING)], unique=True)
    db.items.create_index([("ownerId", ASCENDING)])
    db.bookings.create_index([("itemId", ASCENDING), ("status", ASCENDING), ("startDate", ASCENDING)])
    db.bookings.create_index([("renterId", ASCENDING), ("createdAt", ASCENDING)])
    db.notifications.create_index([("userId", ASCENDING), ("createdAt", ASCENDING)])
    migrate_sqlite_data()
    if db.items.count_documents({}) == 0:
        owner_id = str(uuid.uuid4())
        db.users.insert_one({
            "_id": owner_id,
            "name": "Rentify Demo Owner",
            "email": "owner@rentify.local",
            "phone": "9800000000",
            "passwordHash": hash_password("RentifyDemo123!"),
            "createdAt": now_utc(),
        })
        db.items.insert_many([{
            "_id": str(uuid.uuid4()),
            "ownerId": owner_id,
            "name": name,
            "category": category,
            "price": price,
            "location": location,
            "image": image,
            "description": description,
            "createdAt": now_utc(),
        } for name, category, price, location, image, description in SEED_LISTINGS])


@asynccontextmanager
async def lifespan(_app):
    initialize_database()
    yield
    client.close()


app = FastAPI(title="Rentify API", lifespan=lifespan)


@app.exception_handler(ApiError)
async def handle_api_error(_request, error):
    return error_response(error)


@app.get("/api/me")
def get_me(request: Request):
    user = current_user(request)
    return {"user": public_user(user) if user else None}


@app.post("/api/register", status_code=201)
async def register(request: Request):
    enforce_auth_limit(request)
    body = await request_body(request)
    name, email, phone, password = (
        body.get("name"), body.get("email"), body.get("phone"), body.get("password")
    )
    if not isinstance(name, str) or not 2 <= len(name.strip()) <= 100:
        raise ApiError(400, "Enter a name between 2 and 100 characters.")
    if not isinstance(email, str) or not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email) or len(email) > 254:
        raise ApiError(400, "Enter a valid email address.")
    if not isinstance(phone, str) or not 5 <= len(phone.strip()) <= 20:
        raise ApiError(400, "Enter a valid contact number.")
    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        raise ApiError(400, "Password must be between 8 and 128 characters.")
    user = {
        "_id": str(uuid.uuid4()),
        "name": name.strip(),
        "email": email.strip().lower(),
        "phone": phone.strip(),
        "passwordHash": hash_password(password),
        "createdAt": now_utc(),
    }
    try:
        db.users.insert_one(user)
    except DuplicateKeyError:
        raise ApiError(409, "An account with this email already exists.")
    response = JSONResponse(status_code=201, content={"user": public_user(user)})
    response.set_cookie(COOKIE_NAME, make_session(user["_id"], 7 * 86400), max_age=7 * 86400,
                        httponly=True, samesite="lax", secure=os.getenv("COOKIE_SECURE") == "true")
    return response


@app.post("/api/login")
async def login(request: Request):
    enforce_auth_limit(request)
    body = await request_body(request)
    email, password = body.get("email"), body.get("password")
    if not isinstance(email, str) or not isinstance(password, str):
        raise ApiError(400, "Enter your email and password.")
    user = db.users.find_one({"email": email.strip().lower()})
    password_hash = user.get("passwordHash", "") if user else ""
    valid_password = verify_password(password, password_hash) if user else False
    if not user or not valid_password:
        raise ApiError(401, "Incorrect email or password.")
    response = JSONResponse(content={"user": public_user(user)})
    max_age = 7 * 86400 if body.get("remember") is True else 8 * 3600
    response.set_cookie(COOKIE_NAME, make_session(user["_id"], max_age),
                        max_age=max_age,
                        httponly=True, samesite="lax",
                        secure=os.getenv("COOKIE_SECURE") == "true")
    return response


@app.post("/api/logout", status_code=204)
def logout(user=Depends(require_user)):
    response = Response(status_code=204)
    response.delete_cookie(COOKIE_NAME, httponly=True, samesite="lax")
    return response


@app.get("/api/items")
def get_items():
    items = list(db.items.find().sort([("createdAt", -1), ("_id", -1)]))
    return {"items": [public_item(item) for item in items]}


@app.post("/api/items", status_code=201)
async def create_item(request: Request, user=Depends(require_user)):
    body = await request_body(request)
    name, category, price = body.get("name"), body.get("category"), body.get("price")
    location, image, description = body.get("location"), body.get("image"), body.get("description")
    if not isinstance(name, str) or not 3 <= len(name.strip()) <= 100:
        raise ApiError(400, "Item name must be between 3 and 100 characters.")
    if category not in ALLOWED_CATEGORIES:
        raise ApiError(400, "Choose a valid category.")
    if isinstance(price, bool) or not isinstance(price, (int, float)) or not 1 <= price <= 10000000 or int(price) != price:
        raise ApiError(400, "Enter a valid daily price.")
    if not isinstance(location, str) or not 2 <= len(location.strip()) <= 120:
        raise ApiError(400, "Enter a pickup location.")
    if not isinstance(description, str) or not 10 <= len(description.strip()) <= 2000:
        raise ApiError(400, "Description must be between 10 and 2,000 characters.")
    image_url = DEFAULT_IMAGE
    if isinstance(image, str) and image.strip():
        parsed = urlparse(image.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.netloc:
            raise ApiError(400, "Image must be a valid http or https URL.")
        image_url = image.strip()
    item = {
        "_id": str(uuid.uuid4()),
        "ownerId": str(user["_id"]),
        "name": name.strip(),
        "category": category,
        "price": int(price),
        "location": location.strip(),
        "image": image_url,
        "description": description.strip(),
        "createdAt": now_utc(),
    }
    db.items.insert_one(item)
    return JSONResponse(status_code=201, content={"item": public_item(item)})


@app.get("/api/bookings")
def get_bookings(user=Depends(require_user)):
    user_id = str(user["_id"])
    owned_ids = [item["_id"] for item in db.items.find({"ownerId": user_id}, {"_id": 1})]
    bookings = list(db.bookings.find({
        "$or": [{"renterId": user_id}, {"itemId": {"$in": owned_ids}}]
    }).sort([("createdAt", -1), ("_id", -1)]))
    return {"bookings": [booking for booking in (
        public_booking(item, user_id) for item in bookings
    ) if booking]}


@app.post("/api/bookings", status_code=201)
async def create_booking(request: Request, user=Depends(require_user)):
    body = await request_body(request)
    item_id, start_date = body.get("itemId"), body.get("startDate")
    duration_days, pickup = body.get("durationDays"), body.get("pickupLocation")
    item = db.items.find_one({"_id": str(item_id)})
    if not item:
        raise ApiError(404, "This item is no longer available.")
    if item["ownerId"] == str(user["_id"]):
        raise ApiError(400, "You cannot book your own item.")
    start = parse_date(start_date)
    if not start or start < kathmandu_today():
        raise ApiError(400, "Choose a valid date today or later.")
    if isinstance(duration_days, bool) or not isinstance(duration_days, int) or not 1 <= duration_days <= 30:
        raise ApiError(400, "Rental length must be between 1 and 30 days.")
    if not isinstance(pickup, str) or not 2 <= len(pickup.strip()) <= 120:
        raise ApiError(400, "Enter a pickup location.")
    with write_lock:
        if booking_overlaps(item["_id"], start_date, duration_days):
            raise ApiError(409, "Those dates overlap another active booking request.")
        booking = {
            "_id": str(uuid.uuid4()),
            "itemId": str(item["_id"]),
            "renterId": str(user["_id"]),
            "startDate": start_date,
            "durationDays": duration_days,
            "pickupLocation": pickup.strip(),
            "totalPrice": item["price"] * duration_days,
            "status": "pending",
            "paymentStatus": "pending",
            "createdAt": now_utc(),
        }
        db.bookings.insert_one(booking)
        notify_user(item["ownerId"], "New reservation request",
                    f'{user["name"]} requested {item["name"]} for {duration_days} day(s), starting {start_date}.',
                    "reservation-request", booking["_id"])
    return JSONResponse(status_code=201, content={"bookingId": booking["_id"], "status": "pending"})


@app.patch("/api/bookings/{booking_id}")
async def update_booking(booking_id: str, request: Request, user=Depends(require_user)):
    body = await request_body(request)
    action = body.get("action")
    booking = db.bookings.find_one({"_id": booking_id})
    if not booking:
        raise ApiError(404, "Booking not found.")
    item = db.items.find_one({"_id": booking["itemId"]})
    if not item:
        raise ApiError(404, "The listed item could not be found.")
    user_id = str(user["_id"])
    owner_id = item["ownerId"]

    if action == "cancel":
        can_cancel = booking["status"] == "pending" or (
            booking["status"] == "approved" and booking["paymentStatus"] == "pending"
        )
        if booking["renterId"] != user_id or not can_cancel:
            raise ApiError(403, "This booking cannot be cancelled by your account.")
        db.bookings.update_one({"_id": booking_id}, {"$set": {"status": "cancelled"}})
        notify_user(owner_id, "Reservation cancelled",
                    f'{user["name"]} cancelled the reservation for {item["name"]}.',
                    "reservation-cancelled", booking_id)
        return {"status": "cancelled"}

    if action in {"approve", "decline"}:
        if owner_id != user_id or booking["status"] != "pending":
            raise ApiError(403, "Only the item owner can decide a pending request.")
        with write_lock:
            if action == "approve" and booking_overlaps(
                booking["itemId"], booking["startDate"], booking["durationDays"], booking_id
            ):
                raise ApiError(409, "Another active booking overlaps these dates.")
            status = "approved" if action == "approve" else "declined"
            db.bookings.update_one({"_id": booking_id}, {"$set": {"status": status}})
            notify_user(booking["renterId"], f"Reservation {status}",
                        f'Your request for {item["name"]} was {status}.',
                        f"reservation-{status}", booking_id)
            if action == "approve":
                due_date = end_date(booking["startDate"], booking["durationDays"])
                for recipient, role in ((booking["renterId"], "renter"), (owner_id, "owner")):
                    notify_user(
                        recipient,
                        "Return reminder",
                        f'{item["name"]} is due back on {due_date}. Please coordinate the return with the {("owner" if role == "renter" else "renter")}.',
                        "return-reminder",
                        booking_id,
                        scheduled_date=due_date,
                        key=f"return:{booking_id}:{recipient}",
                    )
        return {"status": status}

    if action == "report-payment":
        if booking["renterId"] != user_id or booking["status"] != "approved" or booking["paymentStatus"] != "pending":
            raise ApiError(403, "Only the renter can report payment for an approved unpaid booking.")
        method = body.get("method")
        if method not in {"Cash", "Bank transfer", "Mobile wallet"}:
            raise ApiError(400, "Choose a valid manual payment method.")
        db.bookings.update_one({"_id": booking_id}, {"$set": {
            "paymentStatus": "reported", "paymentMethod": method,
        }})
        notify_user(owner_id, "Payment reported",
                    f'{user["name"]} reported {method.lower()} payment for {item["name"]}.',
                    "payment-reported", booking_id)
        return {"paymentStatus": "reported"}

    if action == "confirm-payment":
        if owner_id != user_id or booking["paymentStatus"] != "reported":
            raise ApiError(403, "Only the owner can confirm a reported payment.")
        db.bookings.update_one({"_id": booking_id}, {"$set": {"paymentStatus": "paid"}})
        notify_user(booking["renterId"], "Payment confirmed",
                    f"The owner confirmed payment for {item['name']}.",
                    "payment-confirmed", booking_id)
        return {"paymentStatus": "paid"}

    if action == "complete":
        if owner_id != user_id or booking["status"] != "approved":
            raise ApiError(403, "Only the owner can complete an approved booking.")
        if end_date(booking["startDate"], booking["durationDays"]) > kathmandu_today().isoformat():
            raise ApiError(400, "A booking can be completed after its rental period ends.")
        db.bookings.update_one({"_id": booking_id}, {"$set": {"status": "completed"}})
        notify_user(booking["renterId"], "Item marked as returned",
                    f"The owner marked {item['name']} as returned. Thank you for renting with us.",
                    "rental-completed", booking_id)
        return {"status": "completed"}

    raise ApiError(400, "Unknown booking action.")


@app.get("/api/notifications")
def get_notifications(user=Depends(require_user)):
    user_id = str(user["_id"])
    today = kathmandu_today().isoformat()
    notifications = list(db.notifications.find({
        "userId": user_id,
        "$or": [{"scheduledDate": None}, {"scheduledDate": {"$lte": today}}],
    }).sort([("createdAt", -1), ("_id", -1)]).limit(50))
    return {
        "notifications": [{
            "id": str(notification["_id"]),
            "title": notification["title"],
            "message": notification["message"],
            "type": notification["type"],
            "bookingId": notification.get("bookingId"),
            "createdAt": as_iso(notification["createdAt"]),
            "read": notification["read"],
        } for notification in notifications],
        "unreadCount": sum(1 for notification in notifications if not notification["read"]),
    }


@app.patch("/api/notifications/{notification_id}")
def mark_notification_read(notification_id: str, user=Depends(require_user)):
    result = db.notifications.update_one(
        {"_id": notification_id, "userId": str(user["_id"])},
        {"$set": {"read": True}},
    )
    if result.matched_count == 0:
        raise ApiError(404, "Notification not found.")
    return {"status": "read"}


@app.post("/api/notifications/read-all")
def mark_all_notifications_read(user=Depends(require_user)):
    db.notifications.update_many(
        {"userId": str(user["_id"]), "read": False},
        {"$set": {"read": True}},
    )
    return {"status": "read"}


@app.get("/")
@app.get("/index.html")
def index():
    return FileResponse(ROOT / "index.html")


@app.get("/script.js")
def script():
    return FileResponse(ROOT / "script.js", media_type="application/javascript")


@app.get("/style.css")
def style():
    return FileResponse(ROOT / "style.css", media_type="text/css")


@app.exception_handler(Exception)
async def handle_unexpected_error(_request, error):
    print(f"Request failed: {error!r}")
    return JSONResponse(status_code=500, content={"error": "The server could not complete that request."})
