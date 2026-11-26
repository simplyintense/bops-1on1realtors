"use client";

import { createContext, useContext } from "react";

/**
 * Whether the person looking is a signed-in staff member and not an owner (app/page.tsx, from the gate's email). Staff get the Bot
 * Workspace with the owners' controls hidden, so they never click one that the server would refuse. The server is what keeps
 * them out; this only keeps the screen honest.
 */
const StaffContext = createContext(false);

export const StaffProvider = StaffContext.Provider;

export const useStaff = () => useContext(StaffContext);
