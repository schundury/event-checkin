# PrincipiumX Event Check-in

A small single-page web app for checking in attendees at **PrincipiumX: The First Principles Way to Find the Next 10X Opportunity Hiding in Your Product.**

- **Attendees** scan a QR code, open the site, type part of their name (e.g. `jas` → *Jason Bourne*, *Jassie Puji*) and tap **Check in**. The check-in is saved right away; there's no submit button.
- **Hosts** go to `/admin`, sign in with the host password, then:
  - upload a CSV of attendees (first name, last name, company)
  - add attendees one by one
  - see live counts and the full list, check someone in or undo it, remove people
  - export the list with check-in times as CSV
  - show or print the check-in QR code

No dependencies to install. Data is stored in SQLite using Node's built-in `node:sqlite` module.

## Run it

Requires **Node.js 22.13 or newer**.

```bash
ADMIN_PASSWORD='pick-a-strong-password' npm start
```

Then open http://localhost:3000 (attendees) and http://localhost:3000/admin (host).

| Variable         | Default      | Purpose                                  |
|------------------|--------------|------------------------------------------|
| `ADMIN_PASSWORD` | `changeme`   | Host password. **Set this.**             |
| `PORT`           | `3000`       | HTTP port                                |
| `DATA_DIR`       | `./data`     | Folder where `checkin.db` is stored      |

## Attendee CSV format

```csv
First Name,Last Name,Company
Jason,Bourne,Treadstone
Jassie,Puji,Acme Corp
```

- The header row is optional. Without one, the columns are read as first name, last name, company.
- Recognised header names include `First Name`/`First`, `Last Name`/`Surname`, `Company`/`Organization`. A single `Name` column is split into first and last name.
- Comma, semicolon and tab separators all work. For Excel, use **File → Save As → CSV**.
- Rows that exactly match someone already on the list are skipped, so re-uploading a list is safe.

See `sample-attendees.csv` for an example.

## Hosting

Any host that runs a Node 22.13+ process works (Render, Railway, Fly.io, a VM, etc.). Point `DATA_DIR` at a **persistent disk/volume**, or the attendee list and check-ins will be lost when the server restarts or redeploys. Serve it over HTTPS, then open `/admin` on the live URL. The QR code there points to that URL.

## Tests

```bash
npm test
```
