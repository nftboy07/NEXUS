import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { StatusBadge } from "../components/StatusBadge";

describe("StatusBadge", () => {
  it("labels pending states as UNCONFIRMED", () => {
    render(<StatusBadge status="PENDING" />);
    expect(screen.getByText(/UNCONFIRMED/)).toBeTruthy();
  });
  it("confirmed states carry no pending styling", () => {
    const { container } = render(<StatusBadge status="CONFIRMED" />);
    expect(container.querySelector(".badge.pending")).toBeNull();
  });
});
