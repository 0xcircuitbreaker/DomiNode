import { Router } from "express";
import publicRoutes from "./public.js";
import nodeRoutes from "./nodes.js";

/** /v1 agent-network API (DESIGN.md §10). Public routes first; agent routes require requireAgentPrincipal. */
const router = Router();
router.use(publicRoutes);
router.use(nodeRoutes);
export default router;
