# Mimio Recruit (Angular + Node API)

Unified project:
- Angular frontend (`src/`)
- Node/Express API (`server/upload-server.js`)
- ATS module merged into same API and frontend

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Configure `.env` (copy from `.env.example`):

```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
ATS_SUPABASE_URL=https://your-ats-project.supabase.co
ATS_SUPABASE_SERVICE_ROLE_KEY=your-ats-service-role-key
PORT=3333
SUPABASE_RESUME_BUCKET=resumes
MAX_FILES_PER_REQUEST=0
BULK_UPLOAD_CONCURRENCY=8
MAX_RESUME_FILE_SIZE_MB=10
GMAIL_USER=...
GMAIL_PASS=...
```

`/api/ats/*` routes use `ATS_SUPABASE_*` when set. If those are not provided, ATS falls back to `SUPABASE_*`.

3. Start backend API:

```bash
npm run start:api
```

4. Start Angular app:

```bash
npm start
```

Frontend: `http://localhost:4200`  
API: `http://localhost:3333`

## ATS frontend route

- `http://localhost:4200/ats` (protected by existing auth guard)

## ATS API routes

- `GET /api/ats/health`
- `POST /api/ats/upload-resume`
- `POST /api/ats/upload-resumes`
- `GET /api/ats/search?skills=java,spring`
- `GET /api/ats/candidates?limit=200&offset=0`
- `GET /api/ats/candidate/:id`
- ATS SQL setup file: `server/ats/schema.sql`

## Notes

- `MAX_FILES_PER_REQUEST=0` means unlimited files per request.
- Bulk upload processing is concurrency-controlled with `BULK_UPLOAD_CONCURRENCY`.
- Existing endpoints (`/upload`, `/scheduleInterview`) remain available.
