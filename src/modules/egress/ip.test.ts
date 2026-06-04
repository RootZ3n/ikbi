import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyIp } from "./ip.js";

test("public IPv4 addresses are not internal", () => {
  for (const ip of ["8.8.8.8", "1.1.1.1", "203.0.113.5", "172.32.0.1", "11.0.0.1"]) {
    assert.equal(classifyIp(ip).internal, false, ip);
  }
});

test("IPv4 RFC1918 ranges are internal (10/8, 172.16/12, 192.168/16)", () => {
  assert.equal(classifyIp("10.0.0.1").reason, "ipv4_rfc1918");
  assert.equal(classifyIp("10.255.255.255").internal, true);
  assert.equal(classifyIp("172.16.0.1").reason, "ipv4_rfc1918");
  assert.equal(classifyIp("172.31.255.255").internal, true);
  assert.equal(classifyIp("172.15.0.1").internal, false, "just below the /12");
  assert.equal(classifyIp("172.32.0.1").internal, false, "just above the /12");
  assert.equal(classifyIp("192.168.1.1").reason, "ipv4_rfc1918");
});

test("IPv4 loopback, link-local, this-network are internal", () => {
  assert.equal(classifyIp("127.0.0.1").reason, "ipv4_loopback");
  assert.equal(classifyIp("127.255.255.255").internal, true);
  assert.equal(classifyIp("169.254.0.1").reason, "ipv4_link_local");
  assert.equal(classifyIp("0.0.0.0").reason, "ipv4_this_network");
});

test("the cloud metadata IP 169.254.169.254 is explicitly internal", () => {
  const v = classifyIp("169.254.169.254");
  assert.equal(v.internal, true);
  assert.equal(v.reason, "ipv4_cloud_metadata");
});

test("IPv6 loopback / unspecified / link-local / ULA are internal", () => {
  assert.equal(classifyIp("::1").reason, "ipv6_loopback");
  assert.equal(classifyIp("::").reason, "ipv6_unspecified");
  assert.equal(classifyIp("fe80::1").reason, "ipv6_link_local");
  assert.equal(classifyIp("fe80::abcd:1234:5678:9abc").internal, true);
  assert.equal(classifyIp("fc00::1").reason, "ipv6_ula");
  assert.equal(classifyIp("fd12:3456::1").reason, "ipv6_ula");
});

test("public IPv6 is not internal", () => {
  assert.equal(classifyIp("2606:4700:4700::1111").internal, false);
  assert.equal(classifyIp("2001:4860:4860::8888").internal, false);
});

test("IPv4-mapped IPv6 classifies the embedded v4 (internal cannot hide as v6)", () => {
  assert.equal(classifyIp("::ffff:10.0.0.1").internal, true, "mapped RFC1918");
  assert.equal(classifyIp("::ffff:169.254.169.254").reason, "ipv4_cloud_metadata");
  assert.equal(classifyIp("::ffff:8.8.8.8").internal, false, "mapped public stays public");
});

test("unparseable input fails closed (treated as internal)", () => {
  assert.equal(classifyIp("not-an-ip").internal, true);
  assert.equal(classifyIp("999.1.1.1").internal, true);
  assert.equal(classifyIp("").internal, true);
});

test("a zone id on a link-local address does not defeat classification", () => {
  assert.equal(classifyIp("fe80::1%eth0").internal, true);
});
