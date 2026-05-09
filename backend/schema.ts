import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  users: defineTable({
    tokenIdentifier: v.string(),
    knowledgeLevel: v.number(), // 1-5
    knownConcepts: v.array(v.string()),
  }).index("by_token", ["tokenIdentifier"]),
});