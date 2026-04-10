#!/bin/bash

# ============================================================================
# RootsFi Bot - VPS Setup Script
# ============================================================================

echo "=========================================="
echo "  RootsFi Bot - VPS Setup"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if running as root
if [ "$EUID" -eq 0 ]; then 
   echo -e "${RED}Please do not run as root${NC}"
   exit 1
fi

# Backup config if exists
if [ -f "config.json" ]; then
    echo -e "${YELLOW}📦 Backing up config.json...${NC}"
    cp config.json config.json.backup
    echo -e "${GREEN}✅ Backup saved to config.json.backup${NC}"
fi

# Stash local changes
echo -e "${YELLOW}🔄 Stashing local changes...${NC}"
git stash

# Pull from GitHub
echo -e "${YELLOW}⬇️  Pulling from GitHub...${NC}"
git pull origin main

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ Git pull failed!${NC}"
    echo "Please resolve conflicts manually"
    exit 1
fi

# Restore config
if [ -f "config.json.backup" ]; then
    echo -e "${YELLOW}📝 Restoring config.json...${NC}"
    cp config.json.backup config.json
    echo -e "${GREEN}✅ Config restored${NC}"
fi

# Install dependencies
echo -e "${YELLOW}📦 Installing dependencies...${NC}"
npm install

if [ $? -ne 0 ]; then
    echo -e "${RED}❌ npm install failed!${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}=========================================="
echo "  ✅ Setup Complete!"
echo "==========================================${NC}"
echo ""
echo "Next steps:"
echo "1. Check config.json - make sure telegram settings are correct"
echo "2. Run bot:"
echo "   - Main bot: npm start"
echo "   - Check-in: node checkin.js"
echo "   - Monitor: npm run monitor"
echo ""
echo "3. Check Telegram for dashboard!"
echo ""
