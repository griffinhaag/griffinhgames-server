DeploymentREADME.md — GriffinGames Backend Deployment Guide

This document explains how to deploy the GriffinGames multiplayer backend to Railway, how to connect it to the frontend on Netlify, and how to run everything locally.

1. Requirements
Tools Needed

Node.js 18+

Git

GitHub repo containing griffinhgames-server

Railway account

Netlify frontend already deployed (griffinhgames.netlify.app)

2. Local Setup Instructions
Install dependencies
npm install

Run the backend
npm start


This starts the server at:

http://localhost:3000

Frontend Integration (Local)

Set your frontend socket connection to:

const socket = io("http://localhost:3000");

3. Railway Deployment

Railway hosts the backend Node.js server.

Steps:

Log into Railway

Click New Project

Select Deploy from GitHub

Choose your griffinhgames-server repo

Railway will auto-detect Node.js and install dependencies

Region

Use:

US East (Virginia)


This is the lowest latency for Minnesota-based clients.

4. Environment Configuration

The server already binds to:

process.env.PORT || 3000


No additional Railway environment variables are required.

5. Deployment Pipeline
After linking GitHub → Railway:

Every push to main:

triggers a new deployment

builds the project

boots a fresh server instance

updates your live WebSocket endpoint

Nothing else is required.

6. Production Frontend Integration (Netlify)

Your frontend connects to the deployed Railway server using:

const socket = io("https://YOUR-APP.up.railway.app");

Workflow

Backend deploys to Railway

Frontend reads the WebSocket URL

Netlify frontend + Railway backend communicate in real time

Netlify and Railway work perfectly together for this architecture.

7. Verifying Deployment

Visit:

https://YOUR-APP.up.railway.app/


You should see the backend health JSON:

{ "status": "ok", "service": "griffinhgames-server" }


Then open your frontend:

https://griffinhgames.netlify.app


Test creating a room, joining from another device, and verifying that:

room codes generate

players join

room:state updates are received

8. Scaling Notes

Railway is ideal for:

prototypes

low-mid concurrency games

WebSocket applications

instant CI/CD from GitHub

fast debugging

If you outgrow Railway:

This backend can be migrated to:

AWS Elastic Beanstalk

AWS ECS/Fargate

EC2

Fly.io

DigitalOcean

with zero code changes due to its Express + Socket.IO foundation.

9. Troubleshooting
CORS Issues

Update server CORS:

cors: {
  origin: ["https://griffinhgames.netlify.app"]
}

WebSocket connection refused

Verify:

Railway instance is running

Frontend uses correct URL

HTTPS is used on production

Rooms not updating

Check:

socketHandlers.js events

client emits/receives correct event names

10. Summary

You now have:

A modular multiplayer backend

Full WebSocket support

Automatic GitHub → Railway deployment

Netlify → Railway real-time communication

A clean development workflow

Built-in scalability for future game modes