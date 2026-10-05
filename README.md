# Full-Stack Deepseek AI & OCR Web Application

A modern full-stack web application built with TanStack Start, React 19, Supabase, Tailwind CSS, Google Gemini, and Deepseek AI integrations.

---

## 🚀 Features

- **Authentication & User Management**: Supabase Auth with custom user profiles and role management.
- **AI Document & PDF Processing**: High-accuracy OCR, automated question extraction, structured parsing, and text analysis using Google Gemini and Deepseek models.
- **Batch Processing**: Background batch jobs for document ingestion, translation, and automated scoring.
- **Dashboard & Analytics**: Real-time stats, quota tracking, batch progress, and interactive UI components built with Radix UI & Lucide Icons.
- **Export & Storage**: Export documents and extracted data to PDF, DOCX, or JSON formats, with secure file storage in Supabase Storage buckets.

---

## 📋 Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended) or **Bun**: v1.1+
- **npm** / **pnpm** / **bun** package manager
- **Supabase Account**: For authentication, database, and storage
- **Google Gemini API Key**: For OCR and AI features

---

## 🛠️ Quick Start

### 1. Install Dependencies

```bash
npm install
# or
bun install
```

### 2. Configure Environment Variables

Create a `.env` file in the root directory (or use the included `.env` / `.env.example`):

```env
SUPABASE_PROJECT_ID="your-project-id"
SUPABASE_PUBLISHABLE_KEY="your-publishable-key"
SUPABASE_URL="https://your-project-id.supabase.co"
VITE_SUPABASE_PROJECT_ID="your-project-id"
VITE_SUPABASE_PUBLISHABLE_KEY="your-publishable-key"
VITE_SUPABASE_URL="https://your-project-id.supabase.co"
SUPABASE_SERVICE_ROLE_KEY="your-service-role-key"

# Gemini API Keys (comma-separated for key rotation if multiple)
GEMINI_API_KEYS="your-gemini-api-key"
```

### 3. Run Development Server

```bash
npm run dev
# or
bun dev
```

Open your browser at `http://localhost:3000` (or the port specified in terminal).

---

## 🏗️ Building for Production

### Build the Application

```bash
npm run build
```

This generates the Nitro standalone server bundle in the `.output/` folder.

### Preview the Production Build

```bash
npm run start
# or
npx vite preview
```

---

## 📂 Project Structure

```
├── src/
│   ├── components/      # UI components (Radix UI, Shadcn, custom)
│   ├── db/              # Database client & schema definitions
│   ├── hooks/           # Custom React hooks
│   ├── lib/             # Helper utilities, Gemini/Deepseek server logic
│   ├── routes/          # TanStack Router file-based routing
│   └── styles/          # Global styles & Tailwind CSS
├── supabase/            # Supabase migrations, seeds & config
├── public/              # Static assets & public files
├── package.json         # Dependencies & scripts
└── vite.config.ts       # Vite & TanStack Start configuration
```

---

## 📄 License

MIT License. Feel free to use and modify for your projects!
