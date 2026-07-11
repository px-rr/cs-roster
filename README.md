# CS Roster - Employee Management System

Employee management dashboard with roster, leave, and OT tracking.

## Setup Instructions

### 1. Google Sheet & Apps Script Backend

1. Go to [Google Sheets](https://sheets.new) and create a new blank sheet
2. Click **Extensions → Apps Script**
3. Delete any default code and paste the contents of `Code.gs`
4. Click **File → Save**, name the project `CS Roster Backend`
5. Run the `setup()` function once (click Run, authorize when prompted)
6. After setup runs, go to **Deploy → New deployment**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone with the link**
7. Click **Deploy** and copy the **Web app URL**
8. Open `index.html` and replace `YOUR_GAS_WEB_APP_URL_HERE` with the copied URL

### 2. Frontend Hosting (GitHub Pages)

1. Push this repo to GitHub
2. Go to **Settings → Pages**
3. Source: **Deploy from a branch**, Branch: **main**, Folder: **/ (root)**
4. Click **Save**
5. Your site will be live at `https://<username>.github.io/cs-roster/`

### 3. First Login

- **Super Admin**: Username `1101`, Password `1101`
- Create employee profiles from the **New Employee** page
- New employees login with their Employee ID as both username and password

## Features

- Role-based access (Employee / Admin / HR / Accounts / Super Admin)
- Employee profile with 40+ fields
- Roster upload (CSV) and viewing
- Leave management with auto-calculated balances
- OT tracking with auto-calculation
- Notice board
- Photo upload to Google Drive
