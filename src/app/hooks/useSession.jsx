import { useEffect, useState } from "react";
import axios from "axios";

const kratosPublicUrl = "https://orto.lotar122.dev/kratos/public";

export function useSession() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const checkSession = async () => {
      try {
        const res = await axios.get(`${kratosPublicUrl}/sessions/whoami`, {
          withCredentials: true, // send cookies
        });
        setSession(res.data); // session exists
      } catch (err) {
        if (err.response?.status === 401) {
          setSession(null); // no session
        } else {
          console.error(err);
        }
      } finally {
        setLoading(false);
      }
    };

    checkSession();
  }, []);

  return { session, loading };
}
