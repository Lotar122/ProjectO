"use client";

import { useEffect, useState } from "react";

export default function Login(a, b, c, d, e, f, g) {
  const [flowId, setFlowId] = useState("");

  useEffect(() => {
    // Fetch a new login flow ID from Kratos
    // This is OK because it's just a GET and browser will handle it
    fetch("https://orto.lotar122.dev/kratos/public/self-service/login")
      .then((res) => res.json())
      .then((data) => {
        setFlowId(data.id);
      })
      .catch((err) => {
        console.error("Failed to initialize login flow:", err);
      });
  }, []);

  if (!flowId) {
    return <div>Loading...</div>;
  }

  return (
    <form
      action={`https://orto.lotar122.dev/kratos/public/self-service/login?flow=${flowId}`}
      method="POST"
    >
      <input
        type="email"
        name="identifier"
        placeholder="Email"
        required
      />
      <input
        type="password"
        name="password"
        placeholder="Password"
        required
      />
      <button type="submit">Login</button>
    </form>
  );
}
