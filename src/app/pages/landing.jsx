import { User, Package, Calendar, CheckCircle, Clock, XCircle, Eye, EyeOff, LogIn, LogOut, Plus, Search, Filter, ChevronDown, Home, FileText, UserCircle } from 'lucide-react';

export default function Landing({currentPage, setCurrentPage})
{
    return (
	  <div className="container mx-auto px-4 py-16">
			<div className="text-center mb-16">
			  <h1 className="text-5xl font-bold text-white mb-6">ProjectO</h1>
			  <p className="text-xl text-gray-400 max-w-2xl mx-auto">
				Advanced orthodontic management system for streamlined patient care and order tracking
			  </p>
			</div>
 
			<div className="grid md:grid-cols-3 gap-8 mb-16">
			  <div className="bg-gray-900 rounded-xl p-8 text-center text-white">
				<Package className="w-12 h-12 mx-auto mb-4 text-white" />
				<h3 className="text-xl font-semibold mb-2">Order Management</h3>
				<p>Track and manage all orthodontic appliance orders efficiently</p>
			  </div>
			  <div className="bg-gray-900 rounded-xl p-8 text-center text-white">
				<Calendar className="w-12 h-12 mx-auto mb-4 text-white" />
				<h3 className="text-xl font-semibold mb-2">Progress Tracking</h3>
				<p>Monitor treatment progress and order status in real-time</p>
			  </div>
			  <div className="bg-gray-900 rounded-xl p-8 text-center text-white">
				<User className="w-12 h-12 mx-auto mb-4 text-white" />
				<h3 className="text-xl font-semibold mb-2">Patient Care</h3>
				<p>Enhanced patient management and treatment coordination</p>
			  </div>
			</div>
 
			<div className="text-center">
			  <button
				onClick={() => setCurrentPage('login')}
				className="bg-white text-black px-8 py-4 rounded-xl font-semibold text-lg hover:bg-gray-200 transition-colors duration-200 flex items-center gap-2 mx-auto"
			  >
				<LogIn className="w-5 h-5" />
				Access Dashboard
			  </button>
			</div>
		  </div>
	);
}