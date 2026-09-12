# NexCore

NexCore is a self-hosted file storage project. The idea is to give you your own private cloud that you can run on your PC, server, homelab, or VPS.

Think of it as having your own simple Google Drive, but you control where the files are stored.

> ⚠️ NexCore is currently in alpha. Expect bugs, unfinished features, and breaking changes. Don't use it for important data yet.

## Current features

- File uploads
- File storage
- Login/authentication
- User system
- Basic dashboard
- Settings
- Local network access

## Project structure

```text
NexCore/
├── frontend/
│   ├── login/
│   ├── dashboard/
│   └── settings/
│
├── backend/
│   ├── auth/
│   ├── api/
│   └── users/
│
└── storage/
    └── files/
