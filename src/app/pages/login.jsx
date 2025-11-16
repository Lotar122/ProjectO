import React, { useEffect, useState } from "react";
import axios from "axios";

const KratosLogin = () => {
  const [flow, setFlow] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);

  const kratosPublicUrl = "https://orto.lotar122.dev/kratos/public"; // Kratos public endpoint

  // Initialize login flow
  const initFlow = async () => {
    try {
      const res = await axios.get(`${kratosPublicUrl}/self-service/login/api`);
      setFlow(res.data);
    } catch (err) {
      setError(err.response?.data?.error || "Failed to fetch login flow.");
    }
  };

  useEffect(() => {
    initFlow();
  }, []);

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!flow) return;

    try {
      await axios.post(flow.ui.action, {
        method: "password",
        identifier: email,
        password: password,
        csrf_token:
          flow.ui.nodes.find((n) => n.attributes.name === "csrf_token")
            ?.attributes.value,
      });
      alert("Login successful!");
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || "Login failed.");
    }
  };

  if (!flow) return <div>Loading...</div>;

  return (
    <div>
      <h2>Login</h2>
      {error && <p style={{ color: "red" }}>{error}</p>}
      <form onSubmit={handleLogin}>
        <div>
          <label>Email:</label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label>Password:</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button type="submit">Login</button>
      </form>
    </div>
  );
};

export default KratosLogin;
