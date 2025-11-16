import React, { useEffect, useState } from "react";
import axios from "axios";
import PasswordField from "../components/passwordField";
import Loading from "./loading"

const KratosLogin = ({ setCurrentPage }) => {
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
      res = await axios.post(flow.ui.action, {
        method: "password",
        identifier: email,
        password: password,
        csrf_token:
          flow.ui.nodes.find((n) => n.attributes.name === "csrf_token")
            ?.attributes.value,
      });
      setError(null);
    } catch (err) {
		console.log(err);
      setError(err.response?.data?.error || "Login failed.");
    }
  };

  if (!flow) return <Loading />;

  return (
		  <div className="min-h-screen flex items-center justify-center p-4">
			<div className="bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-800">
			  <div className="text-center mb-8">
				<h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
				<p className="text-gray-400">Sign in to your orthodontic dashboard</p>
			  </div>

			  <div className="text-center mb-8">
				{error && <p style={{ color: "red" }}>{error}</p>}
			  </div>
 
			  <form onSubmit={handleLogin} className="space-y-6">
				<div>
				  <label className="block text-sm font-medium text-gray-300 mb-2">
					Email Address
				  </label>
				  <input
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					className="w-full px-4 py-3 border border-gray-700 rounded-lg focus:ring-2 focus:ring-white focus:border-transparent bg-black text-white"
					placeholder="Enter your email"
					required
				  />
				</div>
 
				<PasswordField password={password} setPassword={setPassword} />
 
				<button
				  type="submit"
				  className="w-full bg-white text-black py-3 rounded-lg font-semibold hover:bg-gray-200 transition-colors duration-200"
				>
				  Sign In
				</button>
			  </form>
 
			  <div className="mt-6 text-center">
				<button
				  onClick={(e) => {setCurrentPage('landing')}}
				  className="text-white hover:text-gray-300 font-medium"
				>
				  ← Back to Home
				</button>
			  </div>
			</div>
		  </div>
		);

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
