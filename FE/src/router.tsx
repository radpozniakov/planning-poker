import { createBrowserRouter } from "react-router-dom";
import AppLayout from "./pages/AppLayout";
import Landing from "./pages/Landing";
import Room from "./pages/Room";

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    children: [
      { index: true, element: <Landing /> },
      { path: ":roomCode", element: <Room /> },
    ],
  },
]);
