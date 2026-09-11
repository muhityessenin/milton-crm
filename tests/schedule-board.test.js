"use strict";

const test=require("node:test");
const assert=require("node:assert/strict");
const board=require("../public/schedule-board");

const at=(hour,minute=0)=>`2026-09-15T${String(hour-5).padStart(2,"0")}:${String(minute).padStart(2,"0")}:00.000Z`;

test("schedule grid columns contain only real availability and stay chronological",()=>{
  const slots=[{id:"late",startAt:at(20,30)},{id:"early",startAt:at(19,30)},{id:"same",startAt:at(20,30)}];
  assert.deepEqual(board.columns(slots),["19:30","20:30"]);
});

test("time search returns nearest real free alternatives",()=>{
  const slots=[{id:"occupied",closerId:"c1",status:"BOOKED",startAt:at(20)},{id:"before",closerId:"c2",status:"FREE",startAt:at(19,30)},{id:"after",closerId:"c1",status:"FREE",startAt:at(20,30)}];
  assert.deepEqual(board.nearestFree(slots,"20:00").map((slot)=>[slot.id,slot.time]),[["before","19:30"],["after","20:30"]]);
});

test("free slot navigation preserves exact closer, date and availability slot id",()=>{
  assert.deepEqual(board.preset({id:"slot_20",closerId:"closer_akbota"},"2026-09-15"),{closerId:"closer_akbota",date:"2026-09-15",slotId:"slot_20"});
});

test("day navigation crosses month boundaries without timezone drift",()=>{
  assert.equal(board.shiftDate("2026-09-30",1),"2026-10-01");
  assert.equal(board.shiftDate("2026-09-01",-1),"2026-08-31");
});

test("smart matching ranks matching preferred times first without inventing slots",()=>{
  const items=[{id:"none",createdAt:"2026-09-01",preferredTimeText:"Только утром"},{id:"after",createdAt:"2026-09-02",preferredTimeText:"После 20:00"},{id:"range",createdAt:"2026-09-03",preferredTimeText:"19:00–21:00"}];
  assert.deepEqual(board.rankUnassigned(items,"20:30").map(x=>x.id),["range","after","none"]);
});
