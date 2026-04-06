# Attendance App

Attendance App is a web app for tracking Monday to Thursday roll-call attendance for Year 7 and Year 8 roll classes, importing absence reports from Sentral, calculating weekly student status, and showing the data in a few different staff-facing views.

## What The Site Does

The app has 5 main pages in `docs/`:

- `rewards-board.html`
  This is the main landing page after login. It shows the weighted rewards wheel and the current student status board for a selected year, term, week, and roll class.
- `teacher.html`
  This page is labelled `Attendance Data` in the UI. It shows the detailed roll-call data table for a selected class, including weekly roll-call scores by default.
- `leaderboard.html`
  This shows roll-class rankings for a selected term.
- `admin.html`
  This is where roster files and attendance report files are uploaded.
- `faq.html`
  This is a quick-reference page for common questions about uploads, status rules, and how the app behaves.

The backend lives in `backend/server.js` and stores data in Firestore.

## How Status Is Calculated

The system works from the roster plus the uploaded absence report.

- The roster is the source of truth for which students exist in each roll class.
- Only Year 7 and Year 8 roll classes are included.
  Example roll classes: `07Roll01`, `08Roll03`.
- The attendance logic only cares about Monday to Thursday roll-call attendance.
- For each school week, each student is given an on-time score out of 4.

The stored status levels are:

- `goat` = on time 4 out of 4 days
- `sad1` = on time 3 out of 4 days
- `sad2` = on time 2 out of 4 days
- `sad3` = on time 1 out of 4 days
- `sad4` = on time 0 out of 4 days

If a rostered student does not appear in the uploaded absence report for that week, the system treats them as present and on time for that week.

## Attendance Import Rules

When uploading the Sentral `absence_list` report, the backend automatically works out the relevant term and week from the dates in the file. You do not need to choose a term or week during upload.

A row only counts against roll call when the unexplained absence rule matches.

The unexplained rule is based on the combination of:

- `Shorthand = U` and `Description = Unjustified`, or
- `Shorthand = ?` and `Description = Absent`

The row is then treated as a roll-call miss when the time indicates the student missed morning roll call, including these cases:

- the `Time` cell is blank
- the time starts with `8:00AM`
- the time starts with `8:25AM`
- the time is `8:00AM - 2:45PM`
- the time is `8:25AM - 2:45PM`

This allows unexplained full-day absences to count as missed roll call as well.

## How To Upload Data

### 1. Upload the roster first

Go to `Admin` and upload the roster CSV before uploading any attendance report.

Roster CSV headers required:

- `Surname`
- `Given Names`
- `Student ID`
- `Email`
- `Roll Class`
- `Alias`

What the roster upload does:

- creates or updates student records in Firestore
- stores the roll class for each student
- stores aliases used in the teacher and rewards board views
- creates the student lookup used during attendance imports

### 2. Upload the Sentral attendance report

On the `Admin` page, upload the Sentral `absence_list` export.

Supported file types:

- `.xls`
- `.xlsx`
- `.csv`

What happens during upload:

- the backend reads the dates inside the file
- it infers the correct year, term, and week using the configured 2026 school calendar week grid
- it groups rows by inferred school week
- it recalculates weekly student statuses for each affected week
- it stores snapshots and rollup data used by the rest of the site

A single uploaded report can span multiple weeks. The backend will process each inferred week from that file.

## Recommended Upload Order

If you are rebuilding data from scratch, use this order:

1. Upload the roster CSV.
2. Upload attendance reports.
3. Open `Attendance Data`, `Leaderboard`, or `Rewards Board` to review the results.

If the attendance logic has changed significantly, it is safest to clear old attendance-derived Firestore data and then reupload reports so all weeks are recalculated consistently.

## How The Main Pages Are Used

### Rewards Board

`rewards-board.html` is the main presentation page.

It shows:

- the current selected year, term, week, and roll class
- the most recent available week preselected in the week dropdown
- every student in the selected roll class
- each student's current status icon
- a weighted prize wheel, where stronger attendance statuses have better odds

Current weightings:

- Golden Goat: `10x`
- Sad 1: `6x`
- Sad 2: `3x`
- Sad 3: `1x`
- Sad 4: `0.5x`

### Attendance Data

`teacher.html` is the detailed data page.

It shows:

- the selected year, term, week, and class
- the current status for each student
- weekly roll-call scores by default
- aliases from the uploaded roster where available

### Leaderboard

`leaderboard.html` shows class rankings for a term based on normalised status points.

### Admin

`admin.html` is used for:

- signing in as an admin user
- uploading roster data
- uploading attendance reports
- running quick checks against the current stored data

### FAQs

`faq.html` is a simple help page for common staff questions about roster uploads, attendance uploads, and status calculation.

## Local Structure

- `docs/`
  Frontend pages and scripts.
- `backend/server.js`
  Express backend, upload handling, Firestore access, and rollup endpoints.
- `backend/package.json`
  Backend runtime dependencies.
- `push-update.ps1`
  Helper script for staging, committing, and pushing changes.

## Running The Backend Locally

From the `backend` folder:

```powershell
npm install
npm start
```

The backend expects the Firebase and Firestore environment/configuration used by this project to be available.

## Notes

- The app is currently built around the 2026 Eastern division school calendar week grid configured in the backend.
- Attendance week numbering follows the school calendar week grid, even where the first week of term begins with school development days.
- The site no longer uses a separate student page or separate old rewards spinner page.
