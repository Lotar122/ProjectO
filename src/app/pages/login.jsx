import React, { useEffect, useState } from "react";
import axios from "axios";
import PasswordField from "../components/passwordField";
import Loading from "./loading";
import { useRouter } from "next/navigation";

const KratosLogin = ({ setCurrentPage }) => {
  const [flow, setFlow] = useState(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [session, setSession] = useState(null);
  const [isLoggedIn, setIsLoggedIn] = useState(false);

  const router = useRouter();

  const KRATOS_PUBLIC = "https://orto.lotar122.dev/kratos"; 

  async function checkSession() {
  try {
    const res = await axios.get(`${KRATOS_PUBLIC}/sessions/whoami`, {
      withCredentials: true, // send cookies
    });
    return res.data;
  } catch (err) {
    if (err.response?.status === 401) {
      console.log("No active session");
      return null;
    }
    throw err;
  }
}

  // Initialize browser login flow
  const initFlow = async () => {
	setSession(await checkSession());
	if(session) return;
    try {
      const res = await axios.get(`${KRATOS_PUBLIC}/self-service/login/browser?refresh=true`, {
        withCredentials: true, // Must include cookies for browser flow
      });
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
	if(session) return;

    try {
      // Get CSRF token from the flow nodes
      const csrf = flow.ui.nodes.find((n) => n.attributes.name === "csrf_token")?.attributes.value;

      const res = await axios.post(
        flow.ui.action,
        {
          method: "password",
          identifier: email,
          password: password,
          csrf_token: csrf,
        },
        { withCredentials: true } // Required for browser flow
      );

      setError(null);
      setIsLoggedIn(true);
    } catch (err) {
      console.error(err);
      setError(err.response?.data?.error || "Login failed.");
    }
  };

  useEffect(() => {
    if(session?.active) setIsLoggedIn(true);
  }, [session]);

  useEffect(() => {
    if(isLoggedIn || session?.active)
    {
      router.push('/orders');
      console.log("push orders");
    }
  }, [isLoggedIn, session]);

  if (!flow || session) return <Loading />;

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="bg-gray-900 rounded-2xl shadow-2xl p-8 w-full max-w-md border border-gray-800">
        <div className="text-center mb-8">
          <h2 className="text-3xl font-bold text-white mb-2">Welcome Back</h2>
          <p className="text-gray-400">Sign in to your orthodontic dashboard</p>
        </div>

        {error && <p className="text-red-500 text-center mb-4">{error}</p>}

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-300 mb-2">Email Address</label>
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
            onClick={() => setCurrentPage("landing")}
            className="text-white hover:text-gray-300 font-medium"
          >
            ← Back to Home
          </button>
        </div>
      </div>
    </div>
  );
};

export default KratosLogin;
