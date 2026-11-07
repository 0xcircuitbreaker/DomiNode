import { Router } from "express";
import publicRoutes from "./public.js";
import nodeRoutes from "./nodes.js";
import probeRoutes from "./probe.js";
import creditRoutes from "./credits.js";
import launchRoutes from "./launch.js";

/** /v1 agent-network API (DESIGN.md §10). Public routes first; agent routes require requireAgentPrincipal. */
const router = Router();
router.use(publicRoutes);
router.use(launchRoutes);
router.use(probeRoutes);
router.use(nodeRoutes);
router.use(creditRoutes);
export default router;
