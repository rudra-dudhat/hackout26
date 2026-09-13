# Algae Carbon Monitor - Final Project

## What is included

- Login and registration.
- Persistent SQLite database created automatically on first run.
- Password hashing with bcryptjs.
- User session.
- Search area using Nominatim through the backend.
- Esri World Imagery satellite map.
- Select exactly 4 points.
- Area, hectares, acres and center calculation.
- Live weather through Open-Meteo through the backend.
- Save selected area to the database.
- Backend downloads and stores the satellite image in `uploads/areas/`.
- Saved area history per user.
- Delete saved areas and their image.
- Satellite image can be accessed by the model/backend later through the saved area record.
- No MySQL setup is required.

## Requirements

- Node.js 18 or newer.
- Internet connection for Leaflet tiles, Nominatim, Open-Meteo and Esri satellite imagery.

## Run

Open Terminal inside this folder:

```bash
npm install
npm start
```

Then open:

http://localhost:3000

Do not double-click `index.html`. The Node server must be running.

## First use

1. Open the website.
2. Click Create account.
3. Register.
4. Search a location.
5. Click exactly 4 points.
6. Weather loads automatically.
7. Click `Save Area + Satellite Image`.
8. Wait for the backend to download the image.
9. The image is stored in `uploads/areas/`.
10. Metadata and the image filename are stored in `data/algae_monitor.sqlite`.

## Important

The satellite image is a rectangular image covering the bounding box around the four selected points. The exact four coordinates are stored with it in the database. This is intentional so a future ML model can use both the image and the polygon coordinates.

The satellite service is an external service, so an internet outage can prevent a new image from being downloaded. The application itself remains functional.

## Project structure

algae-carbon-monitor-final/
- server.js
- package.json
- public/
  - index.html
  - login.html
  - register.html
- data/
  - created automatically
- uploads/
  - areas/
    - created automatically

## Database

The project uses SQLite through `sql.js`, so there is no MySQL installation, password, or manual database creation step.

Tables:
- users
- areas


## Google Login Setup

Google Login has been added to `public/login.html`.

1. Copy `.env.example` to `.env`.
2. In Google Cloud Console, create a Web application OAuth client under:
   `Google Auth Platform -> Clients`.
3. Add this Authorized JavaScript origin:
   `http://localhost:3000`
4. Put the generated Client ID in `.env`:
   `GOOGLE_CLIENT_ID=YOUR_CLIENT_ID`
5. Start the project with:
   `npm start`
6. Open:
   `http://localhost:3000/login.html`

The existing email/password login, registration, area selection, satellite-image storage, weather API, and other UI remain unchanged.

Google-only users are automatically created on their first Google login. If a normal account already exists with the same verified Google email, the Google account is linked to that existing account.

## Authentication troubleshooting / fixed version

This version fixes the authentication issues in the original archive:

- Email/password login and registration use the server session correctly.
- Login now shows clear validation and server-error messages and disables the button while signing in.
- Sessions are regenerated after login/registration to avoid session fixation.
- The Google login configuration loader correctly reads `.env` values.
- The Google area no longer stays blank when Google OAuth is not configured; it shows a clear setup message instead.
- Google ID tokens are checked on the server against the configured client ID and verified email.

### Email/password login

No extra configuration is required. Start the server with `npm start`, open `http://localhost:3000/login.html`, and use an account created from **Create account**.

### Optional Google login

Google login requires a Google OAuth Web application client ID. The project includes `.env.example`. Copy it to `.env`, then set:

```text
GOOGLE_CLIENT_ID=YOUR_REAL_GOOGLE_CLIENT_ID.apps.googleusercontent.com
SESSION_SECRET=use-a-long-random-secret
PORT=3000
```

In Google Cloud, add `http://localhost:3000` as an authorized JavaScript origin for the OAuth client. Then restart `npm start`.

If Google is not configured, email/password authentication still works normally and the page explains why Google login is unavailable.
