# Rentify local marketplace

Rentify runs as a same-origin Express application backed by SQLite. Accounts use
server-side sessions and hashed passwords. Listing and booking records are
stored in `data/rentify.sqlite`.

## Run locally

1. Install Node.js 20 or later.
2. From this folder, run `npm install`.
3. Run `npm start`.
4. Open <http://localhost:3000>.

The database and a session-signing secret are created automatically on first
start. Demo marketplace listings are inserted only when the listings table is
empty. Register two accounts to try the renter and owner sides of a booking.
The seeded listings can be managed locally by signing in as
`owner@rentify.local` with password `RentifyDemo123!`. This is a local-demo
account only; remove it and seed credentials before any public deployment.

## Booking and payments

Renters submit booking requests for a date and number of days. Owners can
approve or decline requests; renters can cancel requests. Overlapping active
requests are rejected. For an approved booking, the renter can report a manual
cash/bank payment and the owner can confirm receipt. The app does not collect
or process money.

## Local-development scope

This setup is intended for local development, not public production hosting.
Before deploying publicly, configure HTTPS, a managed session secret, backups,
monitoring, and suitable abuse protections. Item image URLs are stored as text;
image uploads and identity verification are not included.
